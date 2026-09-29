# PostgreSQL

- Scope pools to the caller's lifecycle and accept explicit redacted connection settings.
- Preserve released migrations. Ship schema changes with ordered Effect SQL migrations and required backfills; do not defer them, rewrite released history, or require database resets.
- Keep schema compatibility checks aligned with migration history. Verify fresh installation and upgrades with retained data from the previous release. Document rollout requirements in release notes.
- Never modify pg-boss tables or migration history through router migrations.
- Coordinate concurrent startup: finish router migrations before pg-boss initialization and readiness. Never run migrations at module import.
