import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { SqlClient } from "effect/unstable/sql";
import { Data, Effect, Layer, Schema } from "effect";
import initial from "./migrations/0001_initial.js";
import { rows } from "./query.js";
export class SchemaCompatibilityError extends Data.TaggedError("SchemaCompatibilityError")<{}> {}
export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // This lock also coordinates the first migration-history table creation on an empty database.
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SET LOCAL lock_timeout = '60000ms'`;
      yield* sql`SET LOCAL statement_timeout = '120000ms'`;
      yield* sql`SELECT pg_advisory_xact_lock(715736294138)`;
      // PgMigrator probes with a failing regclass cast before creating its history table.
      // Precreate the pinned migrator's exact table under our lock so that probe cannot abort this transaction.
      // Pin its schema: creating otp_router changes the default search path for the otp_router role.
      yield* sql`CREATE TABLE IF NOT EXISTS public.effect_sql_migrations (migration_id integer PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), name text NOT NULL)`;
      yield* PgMigrator.run({
        table: "public.effect_sql_migrations",
        loader: PgMigrator.fromRecord({
          "0001_initial_schema": initial,
        }),
      });
      const versions = yield* rows(
        Schema.Struct({ migration_id: Schema.Int }),
        sql`SELECT migration_id FROM public.effect_sql_migrations ORDER BY migration_id DESC LIMIT 1`,
      );
      if (versions[0]?.migration_id !== 1)
        return yield* Effect.fail(new SchemaCompatibilityError());
    }),
  );
});
export const DatabaseMigrationsLive = Layer.effectDiscard(migrate);
