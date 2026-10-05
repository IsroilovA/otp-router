# PostgreSQL

- Scope pools to the caller's lifecycle and accept explicit redacted connection settings.
- This refactor intentionally requires a fresh database. Fold changes into the initial schema and change its baseline identity when the stored shape changes; reject superseded baselines without migration or backfill.
- Keep schema compatibility checks aligned with the baseline. Verify fresh installation, repeat startup, and rejection of incompatible databases. Document rollout requirements in release notes.
- Never modify pg-boss tables or migration history through router migrations.
- Coordinate concurrent startup: finish router migrations before pg-boss initialization and readiness. Never run migrations at module import.
