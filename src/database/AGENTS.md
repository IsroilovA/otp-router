# PostgreSQL

- `client.ts` defines the scoped application pool through Effect SQL. Building `DatabaseLive` reads the redacted `DATABASE_URL`; importing it opens no connection.
- Keep feature queries with their feature. This directory owns connections, migrations, and transaction infrastructure.
- Register migrations in `migrations.ts` using `PgMigrator.fromRecord` keys such as `0001_initial_schema`. Keep migration modules under `migrations/` once needed. Do not add an empty migration to populate the scaffold.
- Never modify pg-boss tables or migration history through router migrations.
- Startup must run router migrations, then pg-boss initialization, before readiness or job processing. Preserve database coordination for concurrent starts. Compose platform services at startup; never run migrations at module import.
- Keep pg-boss enqueue on the current Effect SQL transaction using the documented per-call adapter. A second pool cannot join that transaction by sharing the same URL. See [integration evidence](../../docs/research/sql-pg-research.md).
- Validate schema changes, constraints, rollback, and concurrent startup against disposable PostgreSQL when those behaviors are implemented. Type checking cannot validate SQL text.
