# Engine package

`@otp-router/engine` is a private PostgreSQL/pg-boss OTP engine. The self-hosted server is its first consumer. There is no tenant/account model, registry publishing, or interchangeable storage backend. This unreleased version changes stored idempotency results from HTTP statuses to engine outcomes; use a fresh disposable development database. The initial migration is updated directly, with no upgrade shim.

## Supported exports

| Entry | Contract |
| --- | --- |
| `@otp-router/engine` | `Router` operations; input/request/result, snapshot and `ChallengeEvent` schemas; tagged failures; `makeEngineLayer`, `EngineControl`, `ProviderCallbacks`, and `engineMetrics`. |
| `@otp-router/engine/config` | Engine settings/policy schemas, configuration validation, and routing selector types. |
| `@otp-router/engine/providers` | Provider contracts, built-in adapters, and bounded transport extension points. |
| `@otp-router/server` | Reusable `makeApplication` and `serveApplication`; importing them does not start a process. |
| `@otp-router/server/config` | Trusted server `defineConfig` and application configuration validation. |

Private modules, SQL helpers, and persisted record types are not supported imports. All consumers resolve emitted JavaScript and declarations through package exports. Run `pnpm build` first; there are no source aliases.

## Resource lifecycle

Load an engine `Configuration` with `loadConfiguration` inside a scope. Pass the validated result and an explicit redacted database URL to `makeEngineLayer`. Supply Effect platform services for migrations (the Node server uses `NodeServices.layer`). The layer runs migrations and identity/key checks, starts pg-boss, initializes queues, and exposes `Router`, `ProviderCallbacks`, and `EngineControl`. All resources close with the caller's scope; imports open no connections.

The `Router` service offers `create`, `status`, `verify`, `deliver`, and `cancel`. Every operation validates its request. Mutations include an idempotency key and request ID; verification includes its purpose/context binding. Use the exported request schemas for untrusted inputs. Results form a discriminated union of named `outcome`, validated body contract, and `replayed`. The server maps outcomes to HTTP statuses. An incorrect guess is a committed `incorrect_code` outcome, so replay cannot consume another guess. Expected rejections use `DomainError`; infrastructure details are normalized, while defects and interruption remain separate.

Start workers explicitly with `EngineControl.startWorkers({ concurrency, shutdownGraceMs })` in a scope nested inside the resource scope. Its handle exposes `isRunning`, `stopClaims`, and `interrupt`. An API-only consumer creates resources without registering workers. The caller owns signals and should stop new traffic/claims, drain work, then close resources. `EngineControl.probe` checks database connectivity; applications own readiness and its deadline.

`ProviderCallbacks.decode` authenticates and normalizes provider handshake input. `ingest` durably reconciles authenticated events. The application supplies bounded raw bytes and HTTP metadata, and maps normalized failures to transport responses.

## Maintenance and notifications

`EngineControl.replayNotification(eventId)` requeues a retained failed notification with the same event ID and body. `invalidateRestoredChallenges` drains bounded cancellation batches after opening resources with `identityMode: "restore"`. The `adopt-recipient-key` identity mode follows the documented incident procedure. These are operator actions: stop traffic and workers as required by [operations](operations.md).

Snapshot changes, immutable events, notification records, and queued work commit in the same PostgreSQL transaction. Publication is durable; no application callback after commit substitutes for it. Workers deliver webhooks at least once with stable event IDs and bytes. The notification feature owns signing, leases, retries, recovery, replay, and retention; uncertainty in OTP delivery still forbids automatic resend or fallback.

The current database belongs to one application. The trusted configuration selects one notification destination for the deployment. Changing it affects outstanding notifications, including replay. Engine extraction does not provide shared SaaS isolation. See [webhooks](webhooks.md) for retention and receiver ordering.
