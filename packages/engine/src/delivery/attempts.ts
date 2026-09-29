import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SqlClient } from "effect/unstable/sql";
import { canonical } from "../crypto.js";
import { rows, single } from "../database/query.js";
import { databaseTime } from "../database/transaction.js";
import { persistEvent } from "../notifications/publication.js";
import { AttemptSnapshot } from "./history-contracts.js";
import { Attempt, Operation } from "./records.js";

const PublishedAttempt = Schema.Struct({
  ...Attempt.fields,
  public_snapshot: Schema.NullOr(AttemptSnapshot),
});
const comparable = ({
  revision: _revision,
  observedAt: _time,
  ...value
}: typeof AttemptSnapshot.Type) => canonical(value);

const publishAttempt = (attempt: typeof PublishedAttempt.Type) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const operation = yield* single(
      Operation,
      sql`SELECT * FROM otp_router.delivery_operations WHERE id = ${attempt.operation_id}`,
    );
    const provider = operation.snapshot.providers[attempt.route_position];
    if (provider === undefined) return yield* Effect.die(new Error("Attempt provider missing"));
    const time = yield* databaseTime;
    const next = yield* Schema.decodeUnknownEffect(AttemptSnapshot)({
      attemptId: attempt.id,
      operationId: operation.id,
      projectId: operation.project_id,
      revision: attempt.revision + 1,
      routingRevision: attempt.routing_revision,
      providerInstanceId: attempt.provider_instance_id,
      channel: provider.channel,
      reason: attempt.reason,
      createdAt: attempt.due_at.toISOString(),
      dispatchDeadline: attempt.dispatch_deadline.toISOString(),
      dispatchCommittedAt: attempt.reserved_at?.toISOString() ?? null,
      observedAt: time.toISOString(),
      state: attempt.state,
      acceptance: attempt.acceptance,
      failureCategory: attempt.failure_category,
      diagnosticCode: attempt.diagnostic_code,
      invocation: attempt.invocation,
      authorization: {
        state: attempt.authorization_state,
        approvedAt: attempt.approved_at?.toISOString() ?? null,
        validUntil: attempt.approval_expires_at?.toISOString() ?? null,
      },
    });
    if (
      attempt.public_snapshot !== null &&
      comparable(attempt.public_snapshot) === comparable(next)
    )
      return;
    yield* sql`UPDATE otp_router.delivery_attempts SET revision = ${next.revision}, public_snapshot = ${sql.json(next)} WHERE id = ${attempt.id}`;
    yield* sql`UPDATE otp_router.delivery_operations SET history_updated_at = ${time} WHERE id = ${operation.id}`;
    yield* persistEvent({
      eventId: randomUUID(),
      type: "attempt.updated",
      projectId: operation.project_id,
      occurredAt: time.toISOString(),
      attempt: next,
    });
  });

// Domain callers hold the parent lock and run inside deliveryTransaction. Each
// mutation returns its changed rows so intermediate public facts are preserved,
// including bulk suppression/recovery. Private lease bookkeeping emits nothing.
export const transitionAttempts = (mutation: Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
  Effect.gen(function* () {
    const attempts = yield* rows(PublishedAttempt, mutation);
    for (const attempt of attempts) yield* publishAttempt(attempt);
    return attempts;
  });

export const suppressPendingAttempts = (operationId: string, reason?: "fallback") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* transitionAttempts(
      sql`UPDATE otp_router.delivery_attempts SET state = 'suppressed', invocation = 'not_invoked' WHERE operation_id = ${operationId} AND state = 'pending' ${reason === undefined ? sql`` : sql`AND reason = ${reason}`} RETURNING *`,
    );
  });
