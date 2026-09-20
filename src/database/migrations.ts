import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { SqlClient } from "@effect/sql";
import { Data, Effect, Layer, Schema } from "effect";
import controls from "./migrations/0002_deployment_controls.js";
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
      yield* sql`CREATE TABLE IF NOT EXISTS effect_sql_migrations (migration_id integer PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), name text NOT NULL)`;
      yield* PgMigrator.run({
        loader: PgMigrator.fromRecord({
          "0001_initial_schema": initial,
          "0002_deployment_controls": controls,
        }),
      });
      const versions = yield* rows(
        Schema.Struct({ migration_id: Schema.Int }),
        sql`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1`,
      );
      if (versions[0]?.migration_id !== 2)
        return yield* Effect.fail(new SchemaCompatibilityError());
    }),
  );
});
export const DatabaseMigrationsLive = Layer.effectDiscard(migrate);
