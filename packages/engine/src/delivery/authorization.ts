import { lockProject, intentEligible } from "../projects/store.js";
import { transitionAttempts } from "./attempts.js";
import type { Attempt, Operation } from "./records.js";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import { rows } from "../database/query.js";
import { enqueueDelivery } from "../queue/jobs.js";
import type { DeliveryJob } from "../queue/contracts.js";
import { AuthorizationDecision, AuthorizationRequest } from "./authorization-contracts.js";
import { deliveryTransaction } from "./transaction.js";
import { findAttempt, findOperation, expire } from "./store.js";
import { changed } from "./changes.js";
import { lockQuotas } from "./quotas.js";

export const lockProjectSends = (projectId: string) =>
  lockProject(projectId).pipe(
    Effect.andThen(
      lockQuotas([{ scope: "project", scopeId: projectId, kind: "send", maximum: 1, windowMs: 1 }]),
    ),
  );
export const projectBlock = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* rows(
      Schema.Struct({ generation: Schema.Int, blocked_until: Schema.Date }),
      sql`SELECT generation,blocked_until FROM otp_router.project_send_blocks WHERE project_id = ${projectId}`,
    ))[0];
  });

const claimAuthorization = (config: RuntimeConfiguration, job: DeliveryJob) =>
  deliveryTransaction(
    config,
    Effect.gen(function* () {
      const initial = yield* findAttempt(job.attemptId);
      const original = yield* findOperation(initial.operation_id);
      yield* lockProjectSends(original.project_id);
      const operation = yield* expire(yield* findOperation(original.id, true), yield* databaseTime);
      const attempt = yield* findAttempt(initial.id);
      const time = yield* databaseTime;
      if (attempt.state !== "pending" || attempt.authorization_state !== "pending")
        return undefined;
      const sql = yield* SqlClient.SqlClient;
      if (
        !(yield* intentEligible(attempt.intent_id)) ||
        operation.state !== "active" ||
        operation.routing_revision !== job.routingRevision ||
        time >= attempt.dispatch_deadline
      ) {
        yield* transitionAttempts(
          sql`UPDATE otp_router.delivery_attempts SET authorization_state = 'expired', authorization_lease_until = NULL, invocation = 'not_invoked', state = 'suppressed', diagnostic_code = 'authorization_expired' WHERE id = ${attempt.id} RETURNING *`,
        );
        yield* changed(operation.id);
        return undefined;
      }
      const block = yield* projectBlock(operation.project_id);
      if (block !== undefined && block.blocked_until > time) {
        yield* enqueueDelivery(
          job,
          new Date(Math.min(block.blocked_until.getTime(), attempt.dispatch_deadline.getTime())),
        );
        return undefined;
      }
      if (
        (attempt.authorization_lease_until !== null && attempt.authorization_lease_until > time) ||
        (attempt.authorization_retry_at !== null && attempt.authorization_retry_at > time)
      )
        return undefined;
      const provider = operation.snapshot.providers[attempt.route_position];
      if (provider === undefined) return yield* Effect.die(new Error("Attempt provider missing"));
      const request = yield* Schema.decodeUnknownEffect(AuthorizationRequest)({
        deploymentId: config.settings.crypto.deploymentId,
        projectId: operation.project_id,
        attemptId: attempt.id,
        operationId: operation.id,
        ...(operation.integration_reference === null
          ? {}
          : { integrationReference: operation.integration_reference }),
        providerInstanceId: attempt.provider_instance_id,
        channel: provider.channel,
        reason: attempt.reason,
        dispatchDeadline: attempt.dispatch_deadline.toISOString(),
      });
      const generation = attempt.authorization_generation + 1;
      yield* sql`UPDATE otp_router.delivery_attempts SET authorization_generation = ${generation}, authorization_lease_until = ${new Date(time.getTime() + 15000)}, project_generation = ${block?.generation ?? 0} WHERE id = ${attempt.id}`;
      yield* enqueueDelivery(job, new Date(time.getTime() + 15000));
      return { request, generation, projectGeneration: block?.generation ?? 0 };
    }),
  );

type Claim = NonNullable<Effect.Success<ReturnType<typeof claimAuthorization>>>;
const matchingDecision = (claim: Claim, value: AuthorizationDecision) =>
  value.attemptId === claim.request.attemptId &&
  value.projectId === claim.request.projectId &&
  value.deploymentId === claim.request.deploymentId;

const waitForAuthorization = (
  attempt: Attempt,
  operation: Operation,
  time: Date,
  retryAt?: string,
) =>
  Effect.gen(function* () {
    if (attempt.authorization_state !== "pending") return;
    const sql = yield* SqlClient.SqlClient;
    const retry = new Date(
      Math.max(time.getTime() + 5000, retryAt === undefined ? 0 : Date.parse(retryAt)),
    );
    yield* transitionAttempts(
      sql`UPDATE otp_router.delivery_attempts SET authorization_lease_until = NULL, authorization_retry_at = ${retry}, diagnostic_code = 'authorization_pending' WHERE id = ${attempt.id} RETURNING *`,
    );
    if (attempt.state === "pending" && operation.state === "active")
      yield* enqueueDelivery(
        { version: 1, attemptId: attempt.id, routingRevision: attempt.routing_revision },
        new Date(Math.min(retry.getTime(), attempt.dispatch_deadline.getTime())),
      );
    yield* changed(operation.id);
  });

const finishAuthorization = (
  config: RuntimeConfiguration,
  claim: Claim,
  decision: AuthorizationDecision | undefined,
) =>
  deliveryTransaction(
    config,
    Effect.gen(function* () {
      yield* lockProjectSends(claim.request.projectId);
      const operation = yield* expire(
        yield* findOperation(claim.request.operationId, true),
        yield* databaseTime,
      );
      const attempt = yield* findAttempt(claim.request.attemptId);
      if (
        attempt.authorization_generation !== claim.generation ||
        !["pending", "expired"].includes(attempt.authorization_state)
      )
        return;
      const sql = yield* SqlClient.SqlClient;
      const time = yield* databaseTime;
      const value =
        decision !== undefined && matchingDecision(claim, decision) ? decision : undefined;
      if (value === undefined || value.decision === "pending") {
        yield* waitForAuthorization(attempt, operation, time, value?.retryAt);
        return;
      }
      if (value.decision === "denied") {
        if (value.scope === "project") {
          const until = new Date(Math.max(time.getTime() + 1000, Date.parse(value.retryAt)));
          yield* sql`INSERT INTO otp_router.project_send_blocks(project_id,blocked_until) VALUES (${operation.project_id},${until}) ON CONFLICT (project_id) DO UPDATE SET blocked_until = GREATEST(project_send_blocks.blocked_until,EXCLUDED.blocked_until), generation = project_send_blocks.generation + 1`;
        }
        yield* transitionAttempts(
          sql`UPDATE otp_router.delivery_attempts SET authorization_state = 'denied', authorization_lease_until = NULL, invocation = 'not_invoked', state = 'suppressed', diagnostic_code = 'authorization_denied' WHERE id = ${attempt.id} RETURNING *`,
        );
        yield* changed(operation.id);
        return;
      }
      const validUntil = new Date(
        Math.min(Date.parse(value.validUntil), attempt.dispatch_deadline.getTime()),
      );
      const block = yield* projectBlock(operation.project_id);
      const usable =
        (yield* intentEligible(attempt.intent_id)) &&
        attempt.state === "pending" &&
        operation.state === "active" &&
        operation.routing_revision === attempt.routing_revision &&
        validUntil > time &&
        (block?.generation ?? 0) === claim.projectGeneration;
      // Expiring a claim suppresses dispatch, but its matching late decision is still evidence.
      // A suppressed attempt cannot become usable again.
      yield* transitionAttempts(
        sql`UPDATE otp_router.delivery_attempts SET authorization_state = 'approved', approved_at = ${time}, approval_expires_at = ${validUntil}, authorization_lease_until = NULL, invocation = ${usable ? "not_started" : "not_invoked"}, state = ${usable ? "pending" : "suppressed"}, diagnostic_code = ${usable ? null : "approval_unused"} WHERE id = ${attempt.id} RETURNING *`,
      );
      yield* changed(operation.id);
    }),
  );

export const authorizeAttempt = (config: RuntimeConfiguration, job: DeliveryJob) =>
  Effect.gen(function* () {
    const claim = yield* claimAuthorization(config, job);
    if (claim === undefined) return;
    const authorizer = config.authorizer;
    const decision =
      authorizer === undefined
        ? undefined
        : yield* authorizer.reserve(claim.request).pipe(
            Effect.timeout("5 seconds"),
            Effect.flatMap(
              Schema.decodeUnknownEffect(AuthorizationDecision, { onExcessProperty: "error" }),
            ),
            Effect.catch(() => Effect.succeed(undefined)),
          );
    yield* finishAuthorization(config, claim, decision);
  });

// Recovery is independent of queue retry budgets and repairs missing jobs.
export const recoverAuthorizations = (config: RuntimeConfiguration) =>
  deliveryTransaction(
    config,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const due = yield* rows(
        Schema.Struct({ id: Schema.String, routing_revision: Schema.Int }),
        sql`SELECT a.id,a.routing_revision FROM otp_router.delivery_attempts a JOIN otp_router.delivery_operations o ON o.id = a.operation_id WHERE a.state = 'pending' AND o.authorization_required AND o.state = 'active' AND (a.authorization_retry_at IS NULL OR a.authorization_retry_at <= clock_timestamp()) AND (a.authorization_lease_until IS NULL OR a.authorization_lease_until <= clock_timestamp()) ORDER BY a.created_at LIMIT 1000`,
      );
      for (const attempt of due)
        yield* enqueueDelivery({
          version: 1,
          attemptId: attempt.id,
          routingRevision: attempt.routing_revision,
        });
    }),
  );
