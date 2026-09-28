# Engine

## Boundaries

- `challenges/` owns generation, binding, guesses, and verification. `delivery/` owns routing, attempts, quotas, and callbacks; it must not depend on managed verification.
- `notifications/` owns public events and outbound webhooks. Features must not import workers or application startup.
- `providers/` owns contracts and adapters. Normalize external outcomes; never choose fallback providers or verify challenges.
- `queue/` owns pg-boss and must not import feature orchestration. `database/` owns connections, migrations, and transactions. `worker/` processes durable jobs.
- `config/` validates supplied settings; never read environment variables, process arguments, API keys, or listener settings. Importing the engine must not start resources.

## Persistence

- Use parameterized Effect SQL and `SqlSchema` result validation. SQL result annotations alone do not validate rows. Keep queries with their feature and transactions in `SqlClient.withTransaction`.
- Application updates and deletes require explicit predicates. Explain and review intentional whole-table operations; lint does not inspect SQL strings.
- Commit domain changes, replay receipts, events, and queued work atomically. Transactional enqueue must use the current SQL connection; another pool with the same URL cannot join it.
- Never hold a database transaction across provider or selector network work. Preserve the [transaction guarantees](../../docs/data-model.md).

## Delivery and security

- Preserve [routing](../../docs/routing.md) and [security](../../docs/security.md) contracts when changing dispatch, verification, recovery, or callbacks.
- Uncertain delivery never authorizes automatic resend or fallback. Disable transport retries; reserve eligibility and quota before invocation. Recovery must not repeat a dispatched send.
- Explicit resend preserves the original code, deadline, and guess count. Verification and delivery are independent states.
- Never expose OTPs, credentials, full recipients, binding data, or raw provider payloads through logs, metrics, or errors. Persist only allowlisted provider diagnostics.
