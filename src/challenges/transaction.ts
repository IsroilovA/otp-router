import { Effect, Either } from "effect";
import { transaction } from "../database/transaction.js";
import { DomainError } from "./contracts.js";

// Expected rejections may follow logical expiry. Commit that terminal erasure while
// preserving rollback for SQL, queue, decoding failures, defects and interruption.
export const domainTransaction = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  transaction(
    body.pipe(
      Effect.map((value) => Either.right(value)),
      Effect.catchAll((error) =>
        error instanceof DomainError ? Effect.succeed(Either.left(error)) : Effect.fail(error),
      ),
    ),
  ).pipe(Effect.flatMap((result) => result));
