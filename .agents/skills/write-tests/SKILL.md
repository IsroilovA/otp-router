---
name: write-tests
description: Use when deciding whether to add OTP Router tests or when writing, changing, reviewing, or removing them; preserve distinct regression protection with the smallest sufficient suite.
---

# Write tests

## Choose coverage

- Read requirements, implementation, and nearby assertions. Add a test only for a plausible project-owned regression affecting correctness, security, data, delivery costs, or caller-visible behavior that existing coverage or static checks do not protect.
- Give each behavior a primary testing boundary. Keep consumer coverage only for distinct transport, authentication, composition, or concurrency risks. Extend existing scenarios before duplicating them.
- Use the smallest sufficient scope: Vitest for pure decisions, `@effect/vitest` for Effects, real PostgreSQL for persistence, transactions, quotas, and races. Colocate unit tests; put cross-feature/database suites under `tests/`.
- Weigh protection against setup, runtime, flakiness, and maintenance. Skip isolated constructors, getters, forwarders, constants, generated code, compiler guarantees, and dependency behavior. No test-per-file rule, coverage quota, or justification ritual; write no test when none is needed.

## Design assertions

- Derive expectations from requirements or independent examples, never the tested implementation. Resolve contract conflicts instead of encoding current bugs as expected behavior.
- Exercise production interfaces; do not add exports or flags solely for tests. Substitute external providers, transports, and clocks, never the behavior being proved or fixtures that merely test themselves.
- Assert observable outcomes that survive harmless refactors. Reject source-text greps, assertion-free probes, supplied-value checks, and incidental internal call order. Provider invocation counts matter for the no-automatic-retry contract.
- Assert persisted state, quota usage, queued work, and replay results for database guarantees. Mocked rows, SQL snapshots, or spy order cannot establish filtering, atomicity, or concurrency.
- Choose consequential failure paths relevant to the change: definitive rejection, uncertainty, stale callbacks, terminal transitions, and process death around dispatch.
- Use Effect/scoped tests, TestClock for local deadlines, database time for persisted expiry, and barriers for races. Await complete outcomes, release resources, and isolate state; avoid sleeps and uncontrolled network calls. Real sends require explicit authorization and a designated recipient.

## Review and verify

- Check that a plausible bug fails the assertions and that the condition named by the test affects its result. Combine, narrow, or delete redundant coverage only after comparing ownership and nearby tests; similar scenarios can protect independently maintained behavior.
- For bug fixes, demonstrate failure against faulty behavior and success after the fix when feasible. Preserve current work during baseline checks and report when failure-before-fix was not demonstrated.
- Build before focused tests because consumers resolve emitted engine exports. Use `pnpm exec vitest run <file>` for affected groups and `pnpm test` for the suite; broaden for shared infrastructure, dependency changes, or unresolved risks.
- Diagnose timeouts and leaks in the smallest reproducing group; never mask them with retries, skips, or longer timeouts. Add no permanent tests merely to prove tooling is installed.
- Report behavior covered, checks actually run, and material gaps. An empty suite is not passing coverage.
