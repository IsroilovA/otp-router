import { SqlClient } from "effect/unstable/sql";
import { finalizeEvents } from "../notifications/publication.js";
import { Effect, Result } from "effect";
import { transaction as databaseTransaction } from "../database/transaction.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { DomainError } from "../errors.js";
import { Changes } from "./changes.js";
import { flushChanges } from "./publication.js";

export const deliveryTransaction = <A, E, R>(
  config: RuntimeConfiguration,
  body: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if ((yield* Changes) !== undefined) return yield* body;
    return yield* databaseTransaction(
      Effect.gen(function* () {
        const result = yield* body;
        yield* flushChanges(config);
        const finalized = yield* finalizeEvents(config.settings.webhook !== undefined);
        const sql = yield* SqlClient.SqlClient;
        // These are newly inserted subjects already locked by this transaction.
        // Assign listing order under the stream lock, before committing it.
        for (const event of finalized) {
          if (event.revision !== 1) continue;
          if (event.kind === "delivery.updated")
            yield* sql`UPDATE otp_router.delivery_operations SET creation_sequence = ${event.sequence}::bigint WHERE id = ${event.subject_id} AND creation_sequence IS NULL`;
          else if (event.kind === "attempt.updated")
            yield* sql`UPDATE otp_router.delivery_attempts SET creation_sequence = ${event.sequence}::bigint WHERE id = ${event.subject_id} AND creation_sequence IS NULL`;
        }
        return result;
      }).pipe(Effect.provideService(Changes, new Set<string>())),
    );
  });
// Logical expiry and expected domain rejections commit together. Infrastructure
// failures, defects and interruption still roll back the entire transition/event.
export const domainTransaction = <A, E, R>(
  config: RuntimeConfiguration,
  body: Effect.Effect<A, E, R>,
) =>
  deliveryTransaction(
    config,
    body.pipe(
      Effect.map((value) => Result.succeed(value)),
      Effect.catch((error) =>
        error instanceof DomainError && error.code !== "request_in_progress"
          ? Effect.succeed(Result.fail<E>(error))
          : Effect.fail(error),
      ),
    ),
  ).pipe(Effect.flatMap(Effect.fromResult));
