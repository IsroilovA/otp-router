# Architecture

Status: accepted architecture; implementation pending.

## Components

An internal core library owns challenge state, verification, abuse checks, and routing. The HTTP service and worker share that implementation. The HTTP service authenticates callers, validates requests, and maps domain operations to HTTP responses. The core does not depend on HTTP handlers and is not a public integration API. Applications in any language call the service over HTTP.

Provider adapters own request formats, provider authentication, and error normalization. Built-in and external providers implement the same Effect-native contract. Adapters cannot mark a challenge verified or choose the next provider.

A PostgreSQL storage layer supplies atomic operations for state changes, limits, and enqueueing. Its interface is internal. Additional production databases are outside the current scope.

A worker runs durable delivery jobs and expiry cleanup. The self-hosted image defaults to combined API and worker operation and also supports separate roles.

Each deployment serves one application. Independent deployments need separate storage namespaces. See [data ownership](data-model.md#ownership-and-identifiers) and [deployment](operations.md).

## Source organization

Use feature-first modules. `challenges/` owns creation, verification, cancellation, and expiry; `delivery/` owns send actions, routing, dispatch, and outcomes. Colocate feature types, queries, and tests. `providers/`, `http/`, `worker/`, `database/`, and `config/` contain their respective integration concerns. Features never depend on HTTP handlers or worker startup. See [AGENTS.md](../AGENTS.md) for coding conventions.

## Configuration and extensions

One trusted [TypeScript configuration file](operations.md#configuration-entry-file) registers providers, named policies, and secrets at startup. The supported extensions are [provider adapters and creation-time routing selectors](plugins.md). Persist the selected route and non-secret settings before delivery.

Construct services and providers through Effect Layers once per process. Each process owns and closes its runtime and pools under the [shutdown contract](operations.md#graceful-shutdown). Ready providers have no undeclared application-service requirements.

## State and delivery

Verification state is separate from delivery state. Provider acceptance or delivery cannot verify a challenge. Route exhaustion does not invalidate its code. Verification, cancellation, lockout, and expiry prevent pending sends.

Confirmed rejection or final delivery failure advances the configured route. Uncertain delivery waits for an explicit user action. Timed fallback and automatic provider-send retries are not supported in v1. Resend and manual selection preserve the code, expiry, guess count, and shared send limits.

The core owns fallback and user-requested resends. Disable automatic send retries in provider libraries and transports. Worker recovery may resume unsent work or reconcile an uncertain attempt, but must not repeat a provider send. A local timeout does not prove that a provider rejected the request.

See [routing](routing.md) for transitions and race handling, [security](security.md) for limits, and [API design](api.md) for caller-visible behavior.

## Transactions and recovery

Use `@effect/sql-pg` for application SQL and pg-boss for durable work. PostgreSQL is the only required external service.

Commit domain changes, delivery records, idempotency results, and queue work in one transaction using the [transaction-local pg-boss adapter](research/sql-pg-research.md#why-the-integration-works).

Before a provider call, atomically check eligibility and reserve the send in router-owned state. Commit before making the network request, then persist its outcome separately. Queue claims coordinate workers; they do not replace domain checks.

A crash after provider acceptance but before result persistence leaves uncertainty. Reconcile through received authenticated callbacks, persisted correlation data, or late send responses when available, without repeating the send. Automatic provider status polling is deferred under D090. Otherwise, preserve the uncertain outcome. Database locks and queue deduplication cannot guarantee exactly-once external delivery.

The [data model](data-model.md) defines records, lock order, callback correlation, transaction boundaries, and cleanup without resetting active quotas or losing required work.

## Stack rationale

TypeScript supports the service, typed configuration, and package-based plugins.

Effect supplies typed failures, dependency construction, interruption, and scoped resources. The internal core and public provider contract use Effect directly. HTTP callers do not need Effect. There is no parallel Promise-based provider contract. Effect's in-memory scheduling does not replace durable PostgreSQL jobs.

Use the latest stable compatible releases available when implementation begins. Record exact versions in the lockfile and CI rather than freezing planning documents to today's releases. See [dependencies](dependencies.md), the historical [Effect evaluation](research/effect-evaluation.md), and the [SQL experiment](research/sql-pg-research.md).
