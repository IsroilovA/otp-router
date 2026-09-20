# Development rules

## Scope

- Unreleased, with no customers. Make direct breaking changes when needed. Remove superseded code; do not add compatibility shims, deprecated APIs, legacy branches, or parallel implementations. Update callers, tests, and docs together.
- One private package and self-hosted HTTP service. Keep publication private. Follow the owning contracts linked from [README](README.md); research snapshots are historical evidence.
- Implement only the requested scope. Add dependencies and abstractions for concrete needs, not anticipated flexibility.

## Feature-first structure

- Organize behavior under `src/challenges/` and `src/delivery/`. Colocate feature types, operations, SQL queries, and `*.test.ts` files. Create directories when they have code, not placeholder scaffolds.
- `src/providers/` owns the provider contract and adapters. `src/http/` and `src/worker/` translate transport/job inputs into shared feature operations.
- `src/queue/` owns the pg-boss lifecycle and queue integration. Workers call it; it does not import feature orchestration.
- `src/database/` owns connections, migrations, and transaction helpers. `src/config/` owns startup configuration. Avoid global `services/`, `repositories/`, `types/`, or miscellaneous `utils/` collections.
- Features must not import HTTP handlers, worker entry points, or process startup. Providers normalize external outcomes; they never verify challenges or choose the next provider. Avoid import cycles and unnecessary barrel files.

## TypeScript and Effect

- Use the pinned stable Effect API. Check installed types or version-matched official docs; do not copy Effect 4 examples into Effect 3 code.
- Keep domain operations in Effect with explicit tagged failures. Preserve defects and interruption separately. Use Layers for resources and dependency boundaries, not every helper. Run Effects only at process/transport boundaries and tests.
- Validate external input with Effect Schema. Derive types from schemas; use discriminated unions and exhaustive handling. Never use `any`, unsafe casts, non-null assertions, or suppressed diagnostics to bypass a missing model or validation.
- Use `unknown` only at untrusted boundaries and validate it before domain use. Do not replace domain models with untyped property bags or use `eval`/`Function` to bypass static checks.
- Keep plain calculations pure. Prefer readonly data, named exports, type-only imports, and explicit `.js` extensions in relative imports.
- Do not disable checks to make code pass. A necessary exception must be narrow and explain the concrete reason. Split complex functions by responsibility, not arbitrary fragments to satisfy a metric.

## PostgreSQL

- Use `@effect/sql-pg`, parameterized Effect SQL, and `SqlSchema` result validation. Keep queries with their feature and transactions in `SqlClient.withTransaction`. SQL result annotations are not validation.
- Write migrations explicitly with Effect SQL. During initial development, update the initial schema directly. Do not add backfills or compatibility migrations.
- Require an explicit predicate for application updates and deletes. Any intentional whole-table operation needs a narrow explanation and review. The current linter does not inspect SQL strings.
- Follow [database rules](src/database/AGENTS.md) when changing connections, queries, or migrations.

## Critical invariants

- Uncertain delivery never triggers automatic resend or provider fallback. Disable transport retries. Explicit resend preserves the original code, deadline, and guess count.
- Commit eligibility and quota reservation before a provider call; never hold a database transaction across network work. Recovery must not repeat a dispatched send.
- Verification and delivery are separate states. Never log OTPs, credentials, full recipients, or raw provider payloads. See [routing](docs/routing.md), [security](docs/security.md), and [transactions](docs/data-model.md) before changing these rules.

## Verification

- Use pnpm and preserve exact versions in the lockfile. `pnpm check` runs TypeScript, Effect diagnostics, typed linting, and formatting checks. `pnpm build` checks emitted output.
- For tests, read [write-tests](.agents/skills/write-tests/SKILL.md). Use `pnpm exec vitest run <file>` for focused runs and `pnpm test` for the suite. Do not present an empty suite as passing coverage.
- Run checks and relevant tests after changes. Report what ran and any unverified behavior. Do not add tests for empty modules or merely to increase coverage.
- Keep agent instructions and docs concise; apply [unslop](.agents/skills/unslop/SKILL.md) when editing prose.
