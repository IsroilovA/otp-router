import { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
import { duration } from "../diagnostics/metrics.js";
import { single } from "./query.js";

export const databaseTime = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* single(
    Schema.Struct({ time: Schema.DateFromSelf }),
    sql`SELECT clock_timestamp() AS time`,
  )).time;
});
export const transaction = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const started = performance.now();
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL lock_timeout = '2000ms'`;
          yield* sql`SET LOCAL statement_timeout = '5000ms'`;
          yield* sql`SET LOCAL TIME ZONE 'UTC'`;
          return yield* body;
        }),
      )
      .pipe(
        Effect.ensuring(Effect.suspend(() => duration("database", performance.now() - started))),
      );
  });
