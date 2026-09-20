# Implementation dependencies

Status: selected stack. Choose stable compatible versions and lock them at implementation time.

## Selected stack

| Responsibility | Recommendation | Reason |
| --- | --- | --- |
| Runtime | Latest stable Node.js supported by the selected dependencies | Use one tested runtime baseline for the service and worker. Production deployments may choose an active LTS release within the supported range. |
| Core and provider contract | Latest stable Effect release | Match the accepted Effect-native design without adopting prerelease versions. |
| Request and configuration validation | Effect Schema | Validate HTTP requests and startup configuration with the same schema library. |
| HTTP service | Effect Platform HttpApi and Node HTTP server | Keep handlers, typed failures, and schemas in the same programming model as the core. |
| HTTP contract documentation | OpenAPI generated through Effect Platform | Derive the wire contract from the endpoint definitions. |
| PostgreSQL access | `@effect/sql-pg` | Compose SQL operations with Effect and preserve explicit transaction control. Atomic enqueue integration passed the research probe. |
| Durable delivery jobs | pg-boss | Reuse PostgreSQL for durable delivery, cleanup jobs, and worker recovery. |
| Tests | Vitest with Effect's testing helpers | Combine ordinary tests with deterministic Effect time and failure tests. |
| Package organization | One router package managed with pnpm | Keep core, service, worker, and built-in providers in private modules with documented configuration and extension exports. No workspace split is required. |
| Database migrations | `PgMigrator` for application tables; pg-boss migration tooling for queue tables | Run both mechanisms during startup under revised D091, before readiness or application job processing. Test upgrade behavior, interrupted startup, and concurrent migration protection. |

Do not add Fastify alongside Effect HttpApi or a second general validation library without a concrete requirement. Existing provider libraries can still be used inside their adapters.

## HTTP rationale

[Effect HttpApi](https://effect.website/docs/v3/api/platform/HttpApi) defines endpoints, errors, and middleware; [OpenApi](https://effect.website/docs/v3/api/platform/OpenApi) derives the wire documentation. This keeps the HTTP layer in the core's programming model.

Test raw webhook bodies, handshake routes, request limits, authentication, cancellation, and generated OpenAPI against actual endpoints.

## Queue comparison

pg-boss supports delayed work, worker recovery, and a [transaction adapter](https://pgboss.io/api/adapters). The [SQL probe](research/sql-pg-research.md) verified atomic enqueue with Effect SQL, including rollback, concurrency, savepoints, and interruption. Capture the Effect runtime inside the transaction and keep the adapter local to the operation. Await the short database-only bridge fully. No separate outbox relay is needed.

Queue retries resume persisted delivery state under the [routing contract](routing.md#delivery-records); they never authorize another invocation of a dispatched send. Lost commit responses require idempotency and reconciliation.

Tune [worker](https://pgboss.io/api/workers) heartbeat, polling, and recovery settings for short-lived OTPs. Keep provider calls outside database transactions. Historical alternatives are in the [research archive](research/effect-evaluation.md#durable-scheduling).

## Tooling and package boundaries

Use one lockfile and one router package under D076. Export supported configuration, provider-adapter, and routing-selector entry points from that package; keep the core, HTTP handlers, and storage implementation private. External plugin packages depend on those public entry points. Package name and registry scope remain open.

Testing reference: [Vitest guide](https://vitest.dev/guide/).

The HTTP service and worker must share one internal core implementation of verification and routing. Small adapters around non-Effect libraries are acceptable. They must not create a second public programming model.

## Strict typing and validation

Enable strict TypeScript throughout, including tests. Use discriminated unions for states and expected failures, with exhaustive handling. Effect error channels carry specific tagged failures; defects and interruption stay separate.

Validate HTTP, configuration, provider responses, callbacks, queue payloads, and persisted structured data with Effect Schema before domain use. Authenticate callbacks separately. Derive types from shared schemas; SQL annotations alone do not validate results.

Do not substitute `any`, unchecked assertions, or suppressed errors for validation. Isolate unavoidable third-party unsafe bridges behind small validated adapters and document their assumptions. CI must check types, error mapping, boundaries, and transitions, alongside authorization, concurrency, and recovery tests.

## Version policy and remaining checks

- Select the latest stable releases of direct dependencies as a compatible set. Do not select beta, release-candidate, or nightly versions merely because their version number is higher.
- Commit exact resolved versions to the lockfile; production installs must not drift.
- Keep one supported Node.js range and test its minimum and preferred versions in CI. Do not encode a permanent major version in the product specification.
- Confirm each direct dependency's license, runtime requirements, and current maintenance before adding it.
- Verify the selected migration mechanisms and choose the phone-number parsing package, formatter, lint setup, and telemetry exporter.
- Test transaction rollback, worker restart, cancellation, and duplicate callbacks against real PostgreSQL.
- Select the PostgreSQL support range and test its oldest supported version.

Rerun the nine [SQL integration checks](research/sql-pg-research.md) and strict type checking with the selected versions. The historical probe used dependencies outside this documentation-only project.
