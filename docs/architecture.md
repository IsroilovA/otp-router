# Architecture

One private `@otp-router/engine` package owns a PostgreSQL database, migrations, pg-boss runtime, managed challenges and independent external-code delivery. The standalone HTTP server consumes supported exports. No storage abstraction, tenancy layer or second routing engine is introduced.

## Ownership

- `delivery/` owns durable operations, immutable recipient/code/deadline, encrypted recoverable secrets, route/template snapshots, provider attempts, routing revisions, send counts, cooldowns, quotas, dispatch, callbacks and delivery snapshots/events.
- `challenges/` owns generation, verification digests, purpose/context binding, guess accounting, verification results and a unique operation link. It composes the delivery primitives transactionally.
- `notifications/` owns one event transport: signing, leases, retries, recovery, replay and retention for both event kinds.
- `providers/` normalizes external results. Adapters receive `operationId` and `attemptId`; they neither verify codes nor choose fallback providers.
- `database/` and `queue/` own concrete resources and transactional enqueue. `worker/` claims typed jobs. Resource composition wires owner projection and maintenance across both capabilities.
- `config/` validates supplied settings without environment, API credentials or process startup. `apps/server` owns HTTP authentication, bounded decoding, OpenAPI, configuration loading and CLI lifecycle.

Delivery has no dependency on challenge records or verification contracts. The resource layer supplies a typed owner-projection boundary. While holding the delivery row lock, it publishes the managed projection in the same transaction. Managed verification acquires that same operation lock before its challenge row; termination closes delivery and erases both kinds of secrets atomically.

## Durable boundaries

A delivery operation is a handoff of one code and fixed deadline. A delivery attempt is one provider invocation. Preparation creates no attempt. Attachment queues initial work; explicit resend creates another attempt and route revision using the same code. Changing APIs cannot bypass recipient or deployment send budgets.

Dispatch commits eligibility, quota reservations and dispatching state before provider I/O. Outcome reconciliation commits separately. Recovery cannot repeat a dispatched invocation; ambiguity remains uncertain. Automatic progression requires confirmed failure.

Delivery and verification have separate public contracts. `delivery.updated` cannot claim verification. A managed snapshot composes the delivery projection and verification state. One event store and notification worker publish both kinds; callbacks after commit do not substitute for atomic publication.

The engine uses pinned Effect 4, explicit tagged failures, Schema-validated boundaries and SQL results. Layers own resources and dependency boundaries. Defects and interruption are preserved separately from expected failures. See [transactions](data-model.md), [routing](routing.md), and [engine API](engine.md).
