# Development plan

Status: the v1 runtime, built-in adapters, and private packaging are implemented. Passing evidence is recorded in [implementation evidence](implementation-evidence.md); provider-specific gaps remain in [provider research](provider-research.md#remaining-provider-evidence).

## Implementation phases

| Phase | Work and exit criteria |
| --- | --- |
| Contracts and fake provider | Implement the [API](api.md) and [extension contracts](plugins.md#extension-contract-v1) with schema-derived strict types and exhaustive errors. Generate OpenAPI. The fake provider must accept, reject, time out, and emit authenticated test callbacks deterministically. |
| First complete flow | Write [migrations and versioned records](data-model.md). Startup migrates both schemas before serving. Create, dispatch, and verify work over HTTP against real PostgreSQL. Replay and terminal secret deletion pass. |
| Routing and recovery | Implement limits, callbacks, and recovery. Test all [acceptance scenarios](specifications.md#acceptance-scenarios), including multi-process quotas, locks, and crashes. Use fake providers and real PostgreSQL; no second storage implementation. |
| Built-in providers | Implement one provider end to end, then the others. Each passes [conformance tests](plugins.md#shared-conformance-tests), onboarding checks, and a live smoke test with recorded API version, date, and redacted configuration. |
| Private release | Build standard and custom-provider images. Compile the external adapter and selector using only package exports. Document backend HTTP examples, process roles, startup, key rotation, and recovery. Complete the [release checklist](release-checklist.md). |

Carry the nine [SQL experiment](research/sql-pg-research.md) checks into database tests. The current PostgreSQL suites cover queue transactions, migrations, quotas, dispatch recovery, callbacks, and verification; remaining release-checklist cases stay tracked in [implementation evidence](implementation-evidence.md).

## Working rules

Follow the contracts for routine implementation details. Raise questions only for changes to behavior, scope, security guarantees, or meaningful operational tradeoffs. Concrete signatures, migration DDL, and measured tuning may be completed during implementation under D054.

Select and lock compatible dependencies under the [version policy](dependencies.md#version-policy-and-remaining-checks). Operators own production traffic and sizing; use the [benchmark procedure](release-checklist.md#benchmark-procedure) without requiring an adopter traffic estimate.

Each rule has one owning contract, listed in the [README](../README.md). Keep historical evidence under `docs/research/`. Add coding-agent instructions with actual supported commands when the implementation exists. Packaging work may start earlier when needed for integration tests.
