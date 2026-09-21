# Architecture

`@otp-router/engine` provides managed OTP challenges and delivery of externally generated codes. The standalone HTTP server consumes its public exports. PostgreSQL stores domain state and durable pg-boss work.

## Ownership

- `delivery/` owns operations, encrypted recipient/code, saved routes, provider attempts, quotas, dispatch and callback reconciliation.
- `challenges/` owns code generation, bound verification, guesses and verification results. Each challenge owns one delivery operation.
- `notifications/` persists public events and delivers signed webhooks, with independent retry and retention.
- `providers/` validates provider settings and translates external outcomes. Adapters neither verify codes nor choose fallback providers.
- `database/` owns connections, migrations and transactions; `queue/` owns pg-boss; `worker/` processes durable jobs.
- `config/` validates supplied engine settings. `apps/server` owns HTTP, authentication, environment/configuration loading, CLI and process lifecycle.

Delivery depends on an owner-projection contract rather than challenge records. Composition supplies the managed projection, allowing delivery changes to update both public views in the same transaction.

Domain operations use Effect with tagged expected failures. Schemas validate boundaries and database results; Layers own resources and dependencies. Callers own scopes and process lifecycle.

See [transaction guarantees](data-model.md), [routing behavior](routing.md), [verification security](security.md), and [engine integration](engine.md).
