import { appendEvidence } from "./evidence.js";
import { changed } from "./changes.js";
import { deliveryTransaction as transaction } from "./transaction.js";
import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import { expire, findOperation, findAttempt } from "./store.js";
import type { Operation, Attempt } from "./records.js";
import { availableProviders, nextProvider } from "./eligibility.js";
import { schedule } from "./schedule.js";
import { decideOutcome, type Outcome } from "./decision.js";

export type { Outcome } from "./decision.js";

export const mergeLockedOutcome = (
  config: RuntimeConfiguration,
  operation: Operation,
  delivery: Attempt,
  outcome: Outcome,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const time = yield* databaseTime;
    yield* appendEvidence(operation, delivery, outcome, time);
    if (outcome.notInvoked === true)
      yield* sql`UPDATE otp_router.delivery_attempts SET invocation = 'not_invoked' WHERE id = ${delivery.id}`;
    const decision = decideOutcome(operation, delivery, outcome);
    if (outcome.retryAt !== undefined)
      yield* sql`INSERT INTO otp_router.provider_restrictions(provider_instance_id,retry_at) VALUES (${delivery.provider_instance_id},${outcome.retryAt}) ON CONFLICT (provider_instance_id) DO UPDATE SET retry_at = GREATEST(provider_restrictions.retry_at,EXCLUDED.retry_at)`;
    if (!decision.applies) return;
    const evidence = decision.evidence;
    yield* sql`UPDATE otp_router.delivery_attempts SET state = ${evidence.state}, acceptance = ${evidence.acceptance}, failure_category = ${evidence.failure_category}, diagnostic_code = ${evidence.diagnostic_code}, completed_at = ${time}, retry_at = COALESCE(${outcome.retryAt ?? null},retry_at) WHERE id = ${delivery.id}`;
    if (operation.state === "active" && decision.changed) yield* changed(operation.id);
    if (decision.stopAutomatic)
      yield* sql`UPDATE otp_router.delivery_operations SET automatic_stopped = true, recipient_invalid = ${decision.recipientInvalid} WHERE id = ${operation.id}`;
    if (decision.suppressPending === "all")
      yield* sql`UPDATE otp_router.delivery_attempts SET state = 'suppressed', invocation = 'not_invoked' WHERE operation_id = ${operation.id} AND state = 'pending'`;
    else if (decision.suppressPending === "fallback")
      yield* sql`UPDATE otp_router.delivery_attempts SET state = 'suppressed', invocation = 'not_invoked' WHERE operation_id = ${operation.id} AND state = 'pending' AND reason = 'fallback'`;
    if (decision.advance) {
      const next = nextProvider(
        yield* availableProviders(config, operation, time),
        delivery.route_position,
      );
      if (
        next !== undefined &&
        next.retryAt === undefined &&
        operation.send_count < operation.snapshot.maxSends
      )
        yield* schedule(operation, next.position, "fallback", time);
    }
  });

export const recordOutcome = (config: RuntimeConfiguration, id: string, outcome: Outcome) =>
  transaction(
    config,
    Effect.gen(function* () {
      const initial = yield* findAttempt(id);
      const locked = yield* findOperation(initial.operation_id, true);
      const operation = yield* expire(locked, yield* databaseTime);
      const delivery = yield* findAttempt(id);
      yield* mergeLockedOutcome(config, operation, delivery, outcome);
    }),
  );
