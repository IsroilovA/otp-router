# Goal

Build a self-hosted OTP router that gives applications one integration for managed verification and externally generated code delivery across Telegram, WhatsApp, SMS, and custom providers. Control provider routing and send costs while preserving verification safety when delivery outcomes are uncertain.

## Scope and architecture

- Unreleased pnpm workspace with no customers. Make direct breaking changes; remove superseded code and update callers together. No compatibility shims or parallel implementations.
- Implement the requested scope. Add dependencies, abstractions, and shared modules only for concrete needs.
- Organize behavior by feature; colocate its operations, schemas, SQL, and tests. Avoid global service/repository/type buckets, unnecessary barrels, and cycles.
- `packages/engine` owns reusable behavior; `apps/server` owns HTTP and process lifecycle. Consumers use supported package exports, never engine source paths or private records.

## TypeScript and Effect

- Use the pinned compiler, tooling, and Effect package set. Check installed types or version-matched official docs before changing Effect APIs.
- Validate external input with Effect Schema; derive types from schemas and handle discriminated unions exhaustively. No `any`, unsafe casts, non-null assertions, or diagnostic suppression to bypass missing validation.
- Use `unknown` at untrusted boundaries and narrow it before domain use. No untyped property bags or dynamic code evaluation.
- Keep domain operations in Effect with tagged failures; distinguish defects and interruption. Use Layers for resources and dependency boundaries. Run Effects only at transport/process boundaries and tests.
- Keep calculations pure. Prefer readonly data, named exports, type-only imports, and explicit `.js` extensions in relative imports.
- Reduce cyclomatic and cognitive complexity by simplifying control flow and extracting cohesive responsibilities. Do not split functions into meaningless helpers merely to satisfy either limit.

## Verification

- Use pnpm and exact dependency versions. `pnpm check` covers TypeScript, Effect diagnostics, typed linting, and formatting; `pnpm build` emits engine, server, then the client.
- Fix failures without weakening checks. Justified lint exceptions use `oxlint-disable-next-line <rule> -- <reason>`; keep them narrow and remove stale directives.
- Run checks at the end of a meaningful phase; repeat only after relevant changes or failures. Report what ran and material gaps.

## Documentation

- Read the relevant contracts linked from [README](README.md) before changing behavior. Update requirements and callers together when the contract changes.
- Keep each rule in one owning guide. Scoped instructions add local requirements without repeating parents; docs describe specifications and external guarantees, not implementation inventories.
