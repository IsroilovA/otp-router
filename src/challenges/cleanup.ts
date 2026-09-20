import { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
import { rows } from "../database/query.js";
import { databaseTime, transaction } from "../database/transaction.js";
import { findChallenge, terminate } from "./store.js";

const cleanupBatch = transaction(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const expired = yield* rows(
      Schema.Struct({ id: Schema.String }),
      sql`SELECT id FROM otp_router.challenges WHERE verification_state = 'active' AND expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
    );
    for (const row of expired)
      yield* terminate(yield* findChallenge(row.id), "expired", yield* databaseTime);
    const time = yield* databaseTime;
    const operations = yield* rows(
      Schema.Struct({ deleted: Schema.Int }),
      sql`DELETE FROM otp_router.idempotency_records WHERE identity IN (SELECT i.identity FROM otp_router.idempotency_records i WHERE i.retain_until <= ${time} AND NOT EXISTS (SELECT 1 FROM otp_router.challenges c WHERE c.id = i.challenge_id AND c.verification_state = 'active') AND NOT EXISTS (SELECT 1 FROM otp_router.deliveries d WHERE d.challenge_id = i.challenge_id AND d.state IN ('pending','dispatching')) LIMIT 1000) RETURNING 1 AS deleted`,
    );
    const history = yield* rows(
      Schema.Struct({ deleted: Schema.Int }),
      sql`DELETE FROM otp_router.challenges WHERE id IN (SELECT id FROM otp_router.challenges WHERE terminal_at < ${new Date(time.getTime() - 7 * 86400000)} AND NOT EXISTS (SELECT 1 FROM otp_router.deliveries d WHERE d.challenge_id = challenges.id AND d.state = 'dispatching') LIMIT 100) RETURNING 1 AS deleted`,
    );
    const quotas = yield* rows(
      Schema.Struct({ deleted: Schema.Int }),
      sql`DELETE FROM otp_router.quota_events WHERE (identity,kind,event_id) IN (SELECT identity,kind,event_id FROM otp_router.quota_events WHERE occurred_at <= ${new Date(time.getTime() - 86400000)} LIMIT 1000) RETURNING 1 AS deleted`,
    );
    const callbacks = yield* rows(
      Schema.Struct({ deleted: Schema.Int }),
      sql`DELETE FROM otp_router.callback_inbox WHERE (provider_instance_id,deduplication_key) IN (SELECT provider_instance_id,deduplication_key FROM otp_router.callback_inbox WHERE received_at < ${new Date(time.getTime() - 7 * 86400000)} LIMIT 1000) RETURNING 1 AS deleted`,
    );
    return (
      expired.length === 100 ||
      operations.length === 1000 ||
      history.length === 100 ||
      quotas.length === 1000 ||
      callbacks.length === 1000
    );
  }),
);
// Drain backlog with separate bounded transactions rather than limiting sustained cleanup throughput
// to one batch per scheduler tick. The Effect remains interruptible between batches.
export const cleanup = Effect.iterate(true, {
  while: (fullBatch) => fullBatch,
  body: () => cleanupBatch,
}).pipe(Effect.asVoid);
export const invalidateRestoredChallenges = transaction(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Deliberate maintenance-only invalidation of every active restored flow, in bounded batches.
    const active = yield* rows(
      Schema.Struct({ id: Schema.String }),
      sql`SELECT id FROM otp_router.challenges WHERE verification_state = 'active' LIMIT 100 FOR UPDATE`,
    );
    for (const row of active)
      yield* terminate(yield* findChallenge(row.id), "cancelled", yield* databaseTime);
    return active.length;
  }),
);
