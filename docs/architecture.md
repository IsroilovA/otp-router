# Architecture

The private `@otp-router/engine` package owns OTP operations and reusable workers. The `@otp-router/server` application consumes its supported exports for the self-hosted HTTP service. PostgreSQL holds challenge state, quotas, idempotent results, and durable queue work through pg-boss. No other external service is required.

## Responsibilities

Inside `packages/engine/src`:

- `challenges/` owns creation, verification, cancellation, expiry, secret retention, and transactional public snapshots/events.
- `delivery/` owns provider selection, explicit sends, dispatch, and outcome/callback reconciliation.
- `notifications/` owns outbound signing, HTTP attempts, leases, bounded retries, recovery, replay, and retention. Its retry semantics are separate from OTP delivery.
- `providers/` translates provider protocols into normalized outcomes. Adapters neither verify codes nor choose fallback providers.
- `database/` and `queue/` own PostgreSQL and pg-boss resources. `worker/` registers and processes reusable jobs. `config/` validates engine settings without loading environment variables.

Inside `apps/server`, `src/http/` owns routes, authentication, request decoding, HTTP status/error mapping, and OpenAPI. `application.ts` constructs listeners and selected roles without executing a CLI. `main.ts` owns argument parsing, command output, and process teardown. `config/` loads application settings and checks cross-configuration constraints. Docker and Compose assets live here.

The package boundary is enforced by package exports and lint rules. Server code cannot import engine source paths or SQL helpers. PostgreSQL and pg-boss are concrete dependencies, with no storage abstraction.

Domain operations use the pinned Effect 4 release candidate with explicit expected failures. Layers construct scoped resources; effects run at process, transport, and test boundaries. Features do not import HTTP handlers or worker entry points.

`DomainError` preserves its literal error code, and each application operation declares its own error subset. The service boundary records a fixed infrastructure failure category before returning `temporarily_unavailable`; it preserves domain errors, defects, and interruption separately. Committed rejection responses, such as an incorrect guess, remain operation results so idempotent replay does not repeat their effects.

## Delivery and verification

Internal delivery state and verification state are independent. One revisioned public state summarizes their observable result. A receipt cannot verify a challenge, and an exhausted delivery route does not invalidate its code.

Each delivery record permits at most one provider invocation. The worker commits eligibility and quota reservation before contacting the provider. It stores the outcome in a separate transaction. Queue retries resume durable state and cannot authorize another invocation of a dispatched record.

A process crash can leave delivery uncertain. Authenticated callbacks may resolve it; recovery never guesses that the message was rejected. See [routing](routing.md) and [transactions](data-model.md).

## Configuration and extensions

Each deployment serves one application and owns its database namespaces. Separate applications use separate databases.

A trusted TypeScript entry file constructs provider instances and named policies. A creation-time selector may choose an ordered subset of a policy's providers. The challenge saves its route and non-secret settings; credentials stay in process configuration.

TypeScript applications can consume the supported [engine API](engine.md), including operations, schemas, resource construction, workers, and maintenance. SQL helpers and persisted records remain private. Other applications integrate over [HTTP](api.md).

The image supports combined, API-only, and worker-only roles. Use compatible configuration across roles and follow the [drain procedure](operations.md#configuration-changes) for incompatible changes.

Extraction does not introduce multi-tenancy. One trusted deployment destination serves all outbound notifications, and changing it redirects outstanding notifications. A future SaaS application must design its own isolation before sharing this database contract.
