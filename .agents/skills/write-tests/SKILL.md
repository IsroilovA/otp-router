---
name: write-tests
description: Write, review, or remove OTP Router tests while preserving distinct regression protection and avoiding redundant or low-value coverage.
---

# Write tests

Use Vitest and `@effect/vitest`; colocate unit tests with their feature and put cross-feature/database integration tests under `tests/`.

## Decide whether to write a test

Before creating a test, read the relevant behavior and existing coverage. Use these conditions as a quick judgment; no scoring or written justification is required. Add a test when all hold:

- A plausible project-owned regression would affect correctness, security, stored data, delivery costs, or a caller-visible outcome.
- Existing tests or static checks do not already protect the same behavior at the relevant boundary. Validating individual pieces does not establish that they work together. A new file or endpoint alone is not a coverage gap.
- The assertions would fail for that regression and survive a harmless refactor. They do more than repeat supplied values or implementation steps.
- The protection justifies setup, runtime, flakiness, and maintenance. No cheaper test at the owning layer provides the same protection.

If these conditions are not met, write no test. Extend existing coverage before adding another scenario. Decide before writing the test.

Useful: two concurrent dispatches cannot both reserve the last send; replay cannot consume another guess. Low value: a config literal contains its declared value, a wrapper calls its only dependency, or an empty module imports successfully. Test wiring only when a consequential integration failure can escape lower-level checks.

## Choose coverage

- Use the smallest sufficient scope. Test pure decisions directly. Persistence, transactions, quotas, and races require real PostgreSQL; mocked rows and SQL snapshots cannot establish those guarantees.
- Skip constructors, getters, forwarders, constants, empty modules, generated code, compiler guarantees, dependency behavior, and ordinary copy changes. No test-per-file rule, coverage quota, or justification comment is required.
- Keep boundary coverage when transport, authentication, composition, or concurrency can fail independently. Avoid repeating the same domain rule through every endpoint or provider.

## Design assertions

- Assert observable results with independent expectations, not values calculated by the implementation under test. Replace external providers/transports and clocks; never mock the behavior being tested.
- Use `it.effect` or scoped Effect tests for Effects. Use TestClock for local deadlines, actual database time for persisted expiry, and barriers for races. Avoid sleeps and uncontrolled network calls.
- Assert persisted state, quota usage, queued work, and replay results for database operations. External send counts are meaningful for the at-most-one-invocation contract; arbitrary internal call order is not.
- Test failures and recovery where consequences differ: definitive rejection, uncertainty, duplicate callbacks, stale routing revisions, terminal transitions, and process death around dispatch. Select the cases relevant to the change, not the entire matrix for every edit.
- Await the complete outcome and release scoped resources. Isolate database state, timers, and mocks. No real provider sends without explicit authorization and a designated recipient.

## Review and run

- Check that a plausible bug would fail the assertion and a harmless refactor would not. Remove assertions that merely repeat fixture inputs, implementation structure, or dependency guarantees.
- Before deleting coverage, compare nearby tests and production ownership. Similar-looking tests may cover separate implementations or integration risks. Preserve distinct regression protection.
- Build the workspace before focused tests; server/consumer tests resolve emitted engine exports. Run the smallest affected group, then broaden only for changed dependencies or unresolved risks. Diagnose timeouts, leaks, and flaky setup; do not mask them with retries, skips, or longer timeouts.
- Do not add permanent tests just to prove the tooling is installed. Report meaningful checks and any gaps honestly.
