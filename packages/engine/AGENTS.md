# Engine

## Boundaries

- `challenges/` owns generation, binding, guesses, and verification. `delivery/` owns routing, attempts, quotas, and callbacks; it must not depend on managed verification.
- `notifications/` owns public events and outbound webhooks. Features must not import workers or application startup.
- `providers/` owns contracts and adapters. Normalize external outcomes; never choose fallback providers or verify challenges.
- `queue/` owns pg-boss and must not import feature orchestration. `database/` owns connections, migrations, and transactions. `worker/` processes durable jobs.
- `config/` validates supplied settings; never read environment variables, process arguments, API keys, or listener settings. Importing the engine must not start resources.

## Persistence

- Use parameterized Effect SQL and schema-validated query results. Type annotations do not validate database rows.
- Application updates and deletes require explicit predicates. Explain and review intentional whole-table operations; lint does not inspect SQL strings.
- Commit domain changes, replay receipts, events, and queued work in the same transaction.
- Never hold a database transaction across provider, selector, or authorization network calls. Preserve the [transaction guarantees](../../docs/data-model.md).

## Delivery and security

- Preserve [routing](../../docs/routing.md) and [security](../../docs/security.md) contracts when changing dispatch, verification, recovery, or callbacks.
