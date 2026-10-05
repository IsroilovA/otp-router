import { cleanupRuntimeSecrets } from "./runtime/retention.js";
import { cleanupAdminReceipts } from "./projects/retention.js";
import { recoverAuthorizations } from "./delivery/authorization.js";
import { recoverDispatches } from "./delivery/recovery.js";
import { cleanupEvents } from "./history/retention.js";
import { deliveryTransaction as transaction } from "./delivery/transaction.js";
import type { RuntimeConfiguration } from "./config/config.js";
import { SqlClient } from "effect/unstable/sql";
import { Effect, Schema } from "effect";
import { rows } from "./database/query.js";
import { databaseTime } from "./database/transaction.js";
import { findOperation, terminate } from "./delivery/store.js";

const cleanupBatch = (config: RuntimeConfiguration) =>
  transaction(
    config,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const expired = yield* rows(
        Schema.Struct({ id: Schema.String }),
        sql`SELECT id FROM otp_router.delivery_operations WHERE state IN ('prepared','active') AND expires_at <= clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
      );
      for (const row of expired)
        yield* terminate(yield* findOperation(row.id), "expired", yield* databaseTime);
      const time = yield* databaseTime;

      const receipts = yield* rows(
        Schema.Struct({ deleted: Schema.Int }),
        sql`DELETE FROM otp_router.request_receipts WHERE identity IN (
          SELECT i.identity FROM otp_router.request_receipts i WHERE i.retain_until <= ${time}
          AND NOT EXISTS (SELECT 1 FROM otp_router.delivery_operations o WHERE o.id = i.operation_id AND o.state IN ('prepared','active'))
          AND (i.capability = 'external' OR NOT EXISTS (SELECT 1 FROM otp_router.delivery_attempts a WHERE a.operation_id = i.operation_id AND a.state IN ('pending','dispatching')))
          LIMIT 1000) RETURNING 1 AS deleted`,
      );
      const history = yield* rows(
        Schema.Struct({ deleted: Schema.Int }),
        sql`DELETE FROM otp_router.delivery_operations WHERE id IN (SELECT id FROM otp_router.delivery_operations WHERE terminal_at IS NOT NULL AND GREATEST(terminal_at,history_updated_at) < ${new Date(time.getTime() - config.settings.historyRetentionDays * 86400000)} AND NOT EXISTS (SELECT 1 FROM otp_router.delivery_attempts d WHERE d.operation_id = delivery_operations.id AND d.state = 'dispatching') LIMIT 100) RETURNING 1 AS deleted`,
      );
      const quotas = yield* rows(
        Schema.Struct({ deleted: Schema.Int }),
        sql`DELETE FROM otp_router.quota_events WHERE (event_id,kind) IN (SELECT event_id,kind FROM otp_router.quota_events WHERE occurred_at <= ${new Date(time.getTime() - 86400000)} LIMIT 1000) RETURNING 1 AS deleted`,
      );
      const callbacks = yield* rows(
        Schema.Struct({ deleted: Schema.Int }),
        sql`DELETE FROM otp_router.callback_inbox WHERE (provider_instance_id,deduplication_key) IN (SELECT provider_instance_id,deduplication_key FROM otp_router.callback_inbox WHERE received_at < ${new Date(time.getTime() - config.settings.historyRetentionDays * 86400000)} AND NOT EXISTS (SELECT 1 FROM otp_router.provider_correlations c WHERE c.provider_instance_id = callback_inbox.provider_instance_id AND c.reference = callback_inbox.reference) LIMIT 1000) RETURNING 1 AS deleted`,
      );
      return (
        expired.length === 100 ||
        receipts.length === 1000 ||
        history.length === 100 ||
        quotas.length === 1000 ||
        callbacks.length === 1000
      );
    }),
  );
// Drain backlog with separate bounded transactions rather than limiting sustained cleanup throughput
// to one batch per scheduler tick. The Effect remains interruptible between batches.
export const cleanup = (config: RuntimeConfiguration) =>
  Effect.gen(function* () {
    yield* recoverDispatches(config);
    yield* recoverAuthorizations(config);
    while (yield* cleanupBatch(config)) {}
    while ((yield* cleanupAdminReceipts) === 1000) {}
    yield* cleanupRuntimeSecrets(config);
    while (
      (yield* cleanupEvents(yield* databaseTime, config.settings.historyRetentionDays)).length ===
      1000
    ) {}
  });
export const invalidateRestoredOperations = (config: RuntimeConfiguration) =>
  transaction(
    config,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Deliberate maintenance-only invalidation of every active restored flow, in bounded batches.
      const active = yield* rows(
        Schema.Struct({ id: Schema.String }),
        sql`SELECT id FROM otp_router.delivery_operations WHERE state IN ('prepared','active') LIMIT 100 FOR UPDATE`,
      );
      for (const row of active)
        yield* terminate(yield* findOperation(row.id), "closed", yield* databaseTime);
      return active.length;
    }),
  );
