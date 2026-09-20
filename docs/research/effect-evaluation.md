# Effect evaluation

Historical evaluation, 2026-09-19. Effect, HttpApi, Schema, and the Effect-native provider contract were accepted; the later [SQL experiment](sql-pg-research.md) selected `@effect/sql-pg` with pg-boss. No performance benchmark was run.

The alternatives below predate those decisions. D068-D069 later removed timed fallback and automatic provider-send retries. Follow the current [routing contract](../routing.md) and [architecture guide](../architecture.md).

## Recommendation

Use Effect for the routing core, service, and provider contract. Plugin authors use Effect for typed failures, dependencies, and cancellation. A single provider contract avoids a parallel Promise-based interface.

The HTTP service remains accessible to applications in any language. Its wire format uses ordinary JSON and HTTP, independent of the service's internal programming model.

Treat the HTTP server, PostgreSQL client, and durable job system as separate package choices. Choosing Effect's core does not automatically select every Effect package.

## Where it helps

| Router requirement | Effect capability | Proposed use |
| --- | --- | --- |
| Different handling for invalid credentials, rejected recipients, throttling, and uncertain sends | Typed errors and selective recovery | Make failure categories explicit. Recover only when the routing policy permits it. |
| Replaceable providers and test implementations | Services and Layers | Construct the configured provider registry and database services once. Substitute fake implementations in tests. |
| Request deadlines and worker shutdown | Interruption and scoped resources | Connect cancellation to provider requests and release resources owned by the router. |
| Bounded retries with delays | Schedule and retry operations | Execute only retries authorized by the attempt policy and persisted budget. |
| Configuration and external input validation | Schema | Define reusable validation and serialization rules without parallel handwritten validators. |
| Expiry, cooldown, and retry tests | TestClock | Exercise time-dependent behavior without waiting for real timers. Database clock behavior still needs integration tests. |

These capabilities are documented in Effect's [error handling](https://effect.website/docs/v4/error-management/expected-errors), [Layers](https://effect.website/docs/v3/requirements-management/layers), [Scope](https://effect.website/docs/v3/resource-management/scope), [retry](https://effect.website/docs/v3/error-management/retrying), [Schema](https://effect.website/docs/v3/schema/introduction), and [TestClock](https://effect.website/docs/v3/testing/testclock) documentation. The concept review covers both current documentation lines; implementation examples must use only the selected major version.

## Core and plugin contract

Internal core operations use Effects with typed domain failures. HTTP request and response schemas belong in the API specification. Expected failures must stay distinct from programming defects and interruption.

Construct the router and providers through Layers with scoped resource ownership. Each router process owns its runtime and runs request or worker Effects inside it. Do not create a new runtime or database pool for each request or provider call.

A provider plugin implements a versioned contract whose operations return Effects. Use one contract for built-in and third-party plugins. Provider construction can depend on its own configuration and HTTP client services. Resolve those dependencies during Layer construction so the registered provider's send operation has no undeclared application requirements. Do not run Effects inside providers merely to convert them back to Promises.

The contract must carry attempt identity, deadline, normalized delivery outcomes, and typed provider failures. Layers manage setup and cleanup. The core decides whether a failure permits retry or fallback; a plugin does not choose the next provider.

Provider-specific SDKs may still return Promises. Wrap those calls inside that provider through Effect's interoperability tools, map their failures, and connect cancellation where the library supports it. That local wrapper does not require a second public provider contract.

Effect can interrupt its own waiting work, but an arbitrary Promise may continue running unless its implementation cooperates with cancellation. Aborting an HTTP request also cannot prove that the provider did not accept the message. Record an uncertain send when the outcome is unknown. Do not free the send for immediate duplicate dispatch merely because the local request was interrupted.

Scope shutdown releases the runtime, database pools, and provider resources owned by each router process. Worker operation and shutdown need explicit lifecycle documentation for combined and separate process roles.

Use one supported Effect major version across the service and plugins and declare compatible peer dependencies. Plugin contract versioning remains separate from Effect versioning. Exact package exports and dependency ranges will be defined with the package layout.

Effect documents runtime construction and execution in its [runtime guide](https://effect.website/docs/v3/runtime).

### Alternative considered

A Promise-returning provider contract would reduce the learning requirement for plugin authors. It would also add conversion and lifecycle code at the provider boundary and hide Effect's typed error channel. The accepted provider contract uses Effect directly.

## What Effect does not decide for us

Effect does not choose fallback policy, make provider calls idempotent, or guarantee that a recipient receives exactly one message. We still own the challenge state machine, send budgets, verification rules, and provider error mapping.

Ordinary fibers, queues, sleeps, and retry schedules run in memory. PostgreSQL must hold the challenge state, durable work, deadlines, and counters needed after a restart. Persist every provider invocation as an attempt; do not hide multiple billable sends inside a generic retry wrapper.

Keep expected provider failures, programming defects, and shutdown interruption distinct. Broad catch-and-fallback logic could hide a bug or send another paid message during shutdown.

Schema validation establishes data shape. It does not establish authorization, webhook authenticity, or permission to send to a recipient. Redaction helpers likewise do not justify storing codes or recipient details in logs.

## Durable scheduling

Effect does offer persistence tools beyond its in-memory runtime. Its workflow example combines workflow execution with a cluster engine and PostgreSQL. Its PersistedQueue documentation describes persisted jobs, worker locks, recovery, and replaceable storage, including SQL.

Sources: [official workflow example](https://github.com/Effect-TS/effect/blob/v3/packages/workflow/README.md), [official PersistedQueue article](https://effect.website/blog/module-of-the-week/persisted-queue).

Recommendation: begin the queue comparison with a maintained PostgreSQL job queue and Effect's persisted queue. Evaluate the full workflow and cluster stack only if the required callback waits and recovery behavior justify it. Do not invent a queue implementation before comparing available packages.

The selected option must support or allow us to implement:

- Atomic challenge creation with a delivery intent, either in one database transaction or through a transactional outbox.
- Delayed work that survives process death, with bounded retries and visible exhausted jobs.
- Worker coordination that remains correct when a lease expires while an old worker is still running.
- Persisted checks of challenge expiry and terminal state immediately before dispatch.
- Deduplication of logical operations, without claiming that queue deduplication guarantees exactly-once external sends.
- Database migrations and code upgrades while work remains pending.
- Service operation with combined or separate API and worker processes.

Persisted job payloads should reference attempt IDs. Do not place plaintext OTPs in queue payloads, recorded workflow results, or diagnostic snapshots. Workers retrieve encrypted send material only while it is needed.

## Release status

Direct npm registry metadata returned these versions on 2026-09-19:

| Package | `latest` | `rc`, when present |
| --- | --- | --- |
| `effect` | `3.22.2` | `4.0.0-rc.116` |
| `@effect/platform` | `0.97.2` | No tag returned |
| `@effect/platform-node` | `0.108.2` | `4.0.0-rc.116` |
| `@effect/sql-pg` | `0.53.0` | `4.0.0-rc.116` |
| `@effect/workflow` | `0.19.1` | No tag returned |
| `@effect/cluster` | `0.60.2` | No tag returned |

Sources: [Effect registry metadata](https://registry.npmjs.org/effect), [platform metadata](https://registry.npmjs.org/@effect/platform), [Node platform metadata](https://registry.npmjs.org/@effect/platform-node), [PostgreSQL package metadata](https://registry.npmjs.org/@effect/sql-pg), [workflow metadata](https://registry.npmjs.org/@effect/workflow), [cluster metadata](https://registry.npmjs.org/@effect/cluster).

Effect's official release announcement identifies v4 as a release candidate. It says broad interface changes are no longer planned, while narrowly scoped breaking changes remain possible. The September 18 update reports continuing RC fixes. See the [v4 RC announcement](https://effect.website/blog/releases/effect/40-rc) and [September 18 update](https://effect.website/blog/this-week-in-effect/136).

Historical recommendation on 2026-09-19: use the then-current stable v3 core rather than the v4 release candidate. This snapshot does not govern implementation. Use the latest stable compatible Effect release selected under the current [architecture guide](../architecture.md).

Companion packages have their own versions and compatibility requirements. The registry shows that current v3 platform and SQL packages require particular Effect v3 ranges and additional peer packages. A stable core does not make every companion package stable. Check the selected package set together and pin it; do not combine v3 examples with v4 package paths.

## Costs and alternatives

Effect adds a programming model that core contributors must learn. They need to understand typed failures, defects, services, scopes, and interruption. Ordinary async TypeScript would reduce that learning cost, but we would need to assemble and consistently apply more separate conventions for these concerns.

Effect becomes a public dependency of the plugin contract. Removing it later would be a breaking API change, and a major Effect upgrade may require coordinated plugin updates. This is an accepted tradeoff; the actual major is whichever latest stable compatible release is selected for implementation.

We have not measured its overhead for this router. Provider latency alone is not evidence that runtime overhead never matters. Benchmark the chosen implementation against a stated capacity target when defining release acceptance criteria.

For AI-assisted development, document the selected major version and the approved patterns. Type checking helps catch incompatible APIs, but does not replace tests for provider side effects or concurrent state changes.

## Framework choices at the time of evaluation

This evaluation proposed comparing Effect Schema, Effect HttpApi, and `@effect/sql-pg` with alternatives. D015 and D039 subsequently selected those packages and pg-boss. Fastify is no longer an open choice. See [architecture](../architecture.md) for the current stack.

## Implementation checks

Before release, prove that the router service can load a custom provider through startup configuration without changing the core. Check typed failure handling and plugin compatibility against the selected Effect version. Test shutdown during a send, preservation of uncertain outcomes, resource ownership, and isolation between router instances. Restart a worker with a pending fallback and verify recovery from PostgreSQL. Verify that an HTTP client needs no Effect dependency.

These checks were not run in this evaluation.
