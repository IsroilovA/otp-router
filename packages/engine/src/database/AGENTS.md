# PostgreSQL

- Scope pools to the caller's lifecycle and accept explicit redacted connection settings.
- Keep one router migration, `migrations/0001_initial.ts`, written with Effect SQL. During unreleased development, fold every schema change into it; do not add incremental migrations or backfills.
- Never modify pg-boss tables or migration history through router migrations.
- Coordinate concurrent startup: finish router migrations before pg-boss initialization and readiness. Never run migrations at module import.
