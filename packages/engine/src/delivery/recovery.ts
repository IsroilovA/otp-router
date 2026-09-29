import { transitionAttempts } from "./attempts.js";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { RuntimeConfiguration } from "../config/config.js";
import { rows } from "../database/query.js";
import { databaseTime } from "../database/transaction.js";
import { count } from "../diagnostics/metrics.js";
import { logEvent } from "../diagnostics/log.js";
import { changed } from "./changes.js";
import { expire, findOperation } from "./store.js";
import { deliveryTransaction } from "./transaction.js";

const recoverBatch = (config: RuntimeConfiguration) =>
  deliveryTransaction(
    config,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Lock the parent before changing attempts, as dispatch and callbacks do.
      const operations = yield* rows(
        Schema.Struct({ id: Schema.String }),
        sql`
      SELECT id FROM otp_router.delivery_operations o
      WHERE EXISTS (SELECT 1 FROM otp_router.delivery_attempts a JOIN otp_router.attempt_dispatches d ON d.attempt_id = a.id
        WHERE a.operation_id = o.id AND a.state = 'dispatching' AND d.recovery_at <= clock_timestamp())
      LIMIT 100 FOR UPDATE SKIP LOCKED
    `,
      );
      for (const { id } of operations) {
        const time = yield* databaseTime;
        const operation = yield* expire(yield* findOperation(id), time);
        const attempts = yield* transitionAttempts(
          sql`
        UPDATE otp_router.delivery_attempts SET state = 'uncertain', acceptance = 'unknown',
          diagnostic_code = 'worker_recovery'
        WHERE operation_id = ${id} AND state = 'dispatching' AND id IN (SELECT attempt_id FROM otp_router.attempt_dispatches WHERE recovery_at <= ${time})
        RETURNING *
      `,
        );
        if (attempts.length > 0 && operation.state === "active") yield* changed(id);
        for (const attempt of attempts) {
          yield* count("recovery", "uncertain");
          yield* logEvent({
            event: "recovery",
            operationId: id,
            attemptId: attempt.id,
            outcome: "uncertain",
          });
        }
      }
      return operations.length === 100;
    }),
  );

export const recoverDispatches = (config: RuntimeConfiguration) =>
  Effect.gen(function* () {
    while (yield* recoverBatch(config)) {}
  });
