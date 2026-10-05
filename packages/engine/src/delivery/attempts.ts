import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SqlClient } from "effect/unstable/sql";
import { canonical } from "../crypto.js";
import { rows } from "../database/query.js";
import { databaseTime } from "../database/transaction.js";
import { persistEvent } from "../history/publication.js";
import { AttemptSnapshot } from "./history-contracts.js";
import { findAttempt, type PublishedAttempt } from "./read.js";

const comparable = ({
  revision: _revision,
  observedAt: _time,
  ...value
}: typeof AttemptSnapshot.Type) => canonical(value);

const publishAttempt = (attempt: typeof PublishedAttempt.Type) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const time = yield* databaseTime;
    const next = yield* Schema.decodeUnknownEffect(AttemptSnapshot)({
      attemptId: attempt.id,
      operationId: attempt.operation_id,
      projectId: attempt.project_id,
      ...(attempt.integration_reference === null
        ? {}
        : { integrationReference: attempt.integration_reference }),
      revision: attempt.revision + 1,
      routingRevision: attempt.routing_revision,
      providerInstanceId: attempt.provider_instance_id,
      channel: attempt.channel,
      reason: attempt.reason,
      createdAt: attempt.created_at.toISOString(),
      dispatchDeadline: attempt.dispatch_deadline.toISOString(),
      dispatchCommittedAt: attempt.committed_at?.toISOString() ?? null,
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
    yield* sql`UPDATE otp_router.delivery_operations SET history_updated_at = ${time} WHERE id = ${attempt.operation_id}`;
    yield* persistEvent({
      eventId: randomUUID(),
      type: "attempt.updated",
      projectId: attempt.project_id,
      occurredAt: time.toISOString(),
      attempt: next,
    });
  });

// Domain callers hold the parent lock and run inside deliveryTransaction. Each
// mutation returns its changed rows so intermediate public facts are preserved,
// including bulk suppression/recovery. Private lease bookkeeping emits nothing.
export const transitionAttempts = (mutation: Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
  Effect.gen(function* () {
    const changed = yield* rows(Schema.Struct({ id: Schema.String }), mutation);
    const attempts = yield* Effect.forEach(changed, ({ id }) => findAttempt(id));
    for (const attempt of attempts) yield* publishAttempt(attempt);
    return attempts;
  });

export const suppressPendingAttempts = (operationId: string, reason?: "fallback") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* transitionAttempts(
      sql`UPDATE otp_router.delivery_attempts SET invocation = 'not_invoked', state = 'suppressed' WHERE operation_id = ${operationId} AND state = 'pending' ${reason === undefined ? sql`` : sql`AND reason = ${reason}`} RETURNING *`,
    );
  });
