import { Effect, Result } from "effect";
import { transaction } from "../database/transaction.js";
import { DomainError } from "./contracts.js";

// Expected rejections may follow logical expiry. Commit that terminal erasure while
// preserving rollback for SQL, queue, decoding failures, defects and interruption.
export const domainTransaction = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  transaction(
    body.pipe(
      Effect.map((value) => Result.succeed(value)),
      Effect.catch((error) =>
        error instanceof DomainError ? Effect.succeed(Result.fail<E>(error)) : Effect.fail(error),
      ),
    ),
  ).pipe(Effect.flatMap(Effect.fromResult));
