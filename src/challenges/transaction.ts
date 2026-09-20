import { Effect, Result } from "effect";
import { transaction as databaseTransaction } from "../database/transaction.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { DomainError } from "./contracts.js";
import { Changes } from "./changes.js";
import { flushChanges } from "./publication.js";

export const challengeTransaction = <A, E, R>(
  config: RuntimeConfiguration,
  body: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if ((yield* Changes) !== undefined) return yield* body;
    return yield* databaseTransaction(
      Effect.gen(function* () {
        const result = yield* body;
        yield* flushChanges(config);
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
  challengeTransaction(
    config,
    body.pipe(
      Effect.map((value) => Result.succeed(value)),
      Effect.catch((error) =>
        error instanceof DomainError ? Effect.succeed(Result.fail<E>(error)) : Effect.fail(error),
      ),
    ),
  ).pipe(Effect.flatMap(Effect.fromResult));
