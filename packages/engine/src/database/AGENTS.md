# PostgreSQL

- Scope pools to the caller's lifecycle and accept explicit redacted connection settings.
- Write migrations explicitly with Effect SQL. During initial development, update the initial schema directly; do not add backfills or compatibility migrations.
- Never modify pg-boss tables or migration history through router migrations.
- Coordinate concurrent startup: finish router migrations before pg-boss initialization and readiness. Never run migrations at module import.
