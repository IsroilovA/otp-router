# Goal

Build a self-hosted OTP router for managed verification and external-code delivery through Telegram, WhatsApp, SMS, and custom providers. Control routing and send costs without compromising verification when delivery is uncertain.

## Scope and architecture

- Treat published HTTP, client, configuration, and persistence contracts as release boundaries. Bump the affected component version and update callers together. Remove superseded code rather than keeping unnecessary parallel implementations.
- Use published component tags and artifacts as the compatibility baseline. Pending changes on `dev` may be revised together; merging to `main` requests publication but does not establish a release.
- Implement the requested scope. Add dependencies, abstractions, and shared modules only for concrete needs.
- Organize behavior by feature; colocate its operations, schemas, SQL, and tests. Avoid global service/repository/type buckets, unnecessary barrels, and cycles.
- `packages/engine` owns reusable behavior; `apps/server` owns HTTP and process lifecycle. Consumers use supported package exports, never engine source paths or private records.

## TypeScript and Effect

- Use the pinned compiler, tooling, and Effect package set. Check installed types or version-matched official docs before changing Effect APIs.
- Validate external input with Effect Schema; derive types from schemas and handle discriminated unions exhaustively. No `any`, unsafe casts, non-null assertions, or diagnostic suppression to bypass missing validation.
- Use `unknown` at untrusted boundaries and narrow it before domain use. No untyped property bags or dynamic code evaluation.
- Keep domain operations in Effect with tagged failures; distinguish defects and interruption. Use Layers for resources and dependency boundaries. Run Effects only at transport/process boundaries and tests.
- Keep calculations pure. Prefer readonly data, named exports, type-only imports, and explicit `.js` extensions in relative imports.
- Simplify control flow and extract cohesive responsibilities. Do not create meaningless helpers to satisfy complexity limits.

## Verification

- Use pnpm and exact dependency versions. Run `pnpm check` for builds, types, Effect diagnostics, lint, and formatting.
- Fix failures without weakening checks. Justified lint exceptions use `oxlint-disable-next-line <rule> -- <reason>`; keep them narrow and remove stale directives.
- Run checks at the end of a meaningful phase; repeat only after relevant changes or failures. Report what ran and material gaps.

## Documentation

- Read the relevant contracts linked from [README](README.md) before changing behavior. Update requirements and callers together when the contract changes.
- Before creating or updating a PR, follow the [changelog rules](docs/releases.md#changelog) for titles, labels, compatibility, and upgrade instructions.
- Keep each rule in one owning guide. Scoped instructions add local requirements without repeating parents.
