import * as PgMigrator from "@effect/sql-pg/PgMigrator";

export const DatabaseMigrationsLive = PgMigrator.layer({
  loader: PgMigrator.fromRecord({}),
});
