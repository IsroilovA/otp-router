# OTP Router

OTP Router is a planned standalone self-hosted HTTP service written in TypeScript for generating, delivering, and verifying phone-number OTPs through configurable provider sequences. The repository contains the accepted design and an initial TypeScript project scaffold. Application behavior is not implemented yet.

## Development setup

Use Node.js 24 or newer and pnpm 12.5.1. Install the locked dependencies:

```sh
pnpm install --frozen-lockfile
```

Available checks:

```sh
pnpm typecheck
pnpm build
pnpm lint
pnpm format:check
pnpm check
pnpm test
```

Run `pnpm format` to format supported files. Build output goes to `dist/`; tests are excluded. `pnpm test` currently checks queue lifecycle failure and interruption; it does not require PostgreSQL. CI runs checks, tests, and builds on Node 24 and 26.

`pnpm typecheck` runs TypeScript 7 and Effect diagnostics. `pnpm lint` runs Oxlint with type information; Biome handles formatting only. Lints reject unsafe types, floating Promises, incomplete union switches, import cycles, focused/skipped tests, complexity above 10, nesting above 4, and more than 4 parameters. Read [AGENTS.md](AGENTS.md) before implementation.

## PostgreSQL foundation

Use `@effect/sql-pg` for parameterized SQL and transactions, `SqlSchema` for result validation, and `PgMigrator` for authored migrations. No ORM or schema-diff generator is installed. `src/database/client.ts` defines a lazy pool layer using a redacted `DATABASE_URL`; `src/database/migrations.ts` defines an empty migration layer. Startup composition, tables, queries, and queue integration remain unimplemented. Importing either module does not connect or migrate.

## Local PostgreSQL and queue

```sh
cp .env.example .env
pnpm db:up
```

Compose runs PostgreSQL 17 on `127.0.0.1:54329` with a persistent volume. The example credentials are for local development. `pnpm db:down` stops the database and preserves its data. This development image does not establish the production PostgreSQL support range.

Node processes must load `.env` explicitly with `node --env-file=.env ...` or receive `DATABASE_URL` from the environment. No application entry point exists yet.

`src/queue/client.ts` exports a scoped `QueueLive` layer. It owns a separate pg-boss pool, starts pg-boss with automatic migrations enabled, and stops it when the scope closes. Startup failures are typed and background logs omit raw error payloads. Shutdown failures become defects so cleanup errors remain visible. The 30-second shutdown timeout is pg-boss's worker-drain limit, not a hard deadline for every database operation.

When composing startup, finish router migrations before building `QueueLive`; keep readiness false until both succeed. Queue handlers, transactional enqueue, startup migration deadlines, and process signal handling belong to the first complete flow.

## Current contracts

Read these documents as the current design. Each rule should have one owning document; cross-references summarize rather than redefine it.

- [Product specification](docs/specifications.md): scope, responsibilities, terminology, and acceptance scenarios.
- [Architecture](docs/architecture.md): components, deployment shape, and system boundaries.
- [Routing and delivery](docs/routing.md): fallback, user-requested resends, delivery state, and concurrency behavior.
- [API design](docs/api.md): HTTP operations, authorization, errors, and idempotency.
- [Verification and security](docs/security.md): OTP lifecycle, abuse controls, cryptography, and secret retention.
- [Provider and extension contracts](docs/plugins.md): provider adapters, routing selectors, templates, and localization.
- [Data model](docs/data-model.md): records, transactions, cleanup, and database invariants.
- [Deployment and operations](docs/operations.md): process roles, configuration changes, restore procedures, observability, and distribution.
- [Provider constraints](docs/provider-research.md): verified Telegram, WhatsApp, and Play Mobile behavior.

The [decision register](docs/decisions.md) is a historical index. When its summary conflicts with an owning contract, the owning contract is authoritative.

## Planning and evidence

- [Implementation plan](docs/development-plan.md) defines the implementation phases.
- [Private release checklist](docs/release-checklist.md) defines required test, provider, and benchmark evidence.
- [Implementation dependencies](docs/dependencies.md) records the selected stack and version policy.
- [Research archive](docs/research/) preserves dated evaluations and reproducible experiments. Research snapshots are evidence, not current version recommendations.

Items marked `Implementation` need code or evidence. Provider-specific unknowns are listed in the provider research.

Licensed under [MIT](LICENSE). Copyright 2026 Alisher Isorilov.
