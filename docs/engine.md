# Engine package

`@otp-router/engine` is one private PostgreSQL/pg-boss package with one database, migration owner, version, and runtime. It supports managed OTP challenges and delivery of externally generated, externally verified numeric phone codes. The initial schema changes directly; use a fresh development database.

## Supported exports

| Entry | Contract |
| --- | --- |
| `@otp-router/engine` | `makeEngineLayer`, `EngineControl`, callbacks, diagnostics, lifecycle failures |
| `@otp-router/engine/challenges` | `Router`: create, status, verify, deliver, cancel; managed request/result/event schemas |
| `@otp-router/engine/delivery` | `Delivery`: prepare, create, submitCode, status, deliver, close; delivery request/result/event schemas |
| `@otp-router/engine/config` | Settings, delivery policy, optional managed settings, configuration validation/selectors |
| `@otp-router/engine/providers` | Provider contracts, existing Telegram, WhatsApp, SMS, fake and custom adapters |
| `@otp-router/server` | Reusable application construction and serving |

Private records and SQL helpers are not supported imports. Build before using consumers; all resolve emitted exports.

## Resource lifecycle

Load a `Configuration` with `loadConfiguration` in a scope. Pass it and an explicit redacted database URL to `makeEngineLayer`; supply platform services such as `NodeServices.layer`. It migrates, validates retained keys/deployment identity, starts pg-boss and exposes both capabilities plus callbacks and control. Imports open no resources.

Start workers explicitly through `EngineControl.startWorkers({ concurrency, shutdownGraceMs })` in a nested scope. API-only callers need not start workers. Stop traffic and claims, drain, then close resources. The caller owns signals and readiness; `probe` checks the database. One deployment owns its database; there is no SaaS tenancy model.

## External lifecycle

`prepare` takes a normalized phone recipient, allowed purpose/policy, opaque context ID, optional locale/routing context/manual choice, and an absolute UTC ISO `expiresAt`. It commits a prepared operation without code or provider attempts. Preparation consumes bounded recipient admission/creation quotas but reserves no future provider capacity.

`submitCode` takes `operationId`, code, idempotency key and request ID. It attaches the code once and queues initial work atomically. Concurrent identical submissions cannot add another attempt, even with distinct request keys. A conflicting attached code is rejected. `create` combines preparation and attachment through the same primitives for callers already holding a code.

`status` returns a redacted snapshot with action forecasts. `deliver` accepts resend, next or explicit selection, always reusing the original code and deadline. `close` permanently stops pending work and erases recoverable secrets. Closed and expired operations never reopen. A replacement code requires a new operation. An in-flight message can still arrive after closure.

These methods cannot mutate a challenge-owned operation. Use its challenge API. Delivery snapshots never contain verify actions or a verified state. The caller's external authority owns verification, identities and sessions; closure is not proof of authentication.

Mutations validate inputs and use durable idempotency. Exact retained replay returns the original safe result with `replayed: true`, which may describe an earlier state; use status for current state. Once terminal code fingerprints are erased, replay ignores code differences and returns the retained receipt without performing work. Expired absolute deadlines also prevent old creation requests from recreating work after retention ends.

## Managed challenges and events

Managed creation generates a code, stores a separately bound verifier, and creates/attaches a delivery operation in one transaction. Challenge snapshots include `operationId`. Verification, lockout, cancellation and expiry atomically close delivery and erase secrets. Explicit sends preserve guess count and deadline.

Both APIs return tagged domain errors; committed incorrect guesses remain results so replay consumes no additional guesses. Infrastructure errors are redacted; defects and interruption remain distinct.

`challenge.updated` and `delivery.updated` are separate typed immutable events using one notification worker. State, projections, events, queue work and replay results commit together. Durable handoff acceptance, provider acceptance and recipient verification are separate milestones.

`EngineControl.replayNotification(eventId)` requeues retained failed events. `invalidateRestoredOperations` drains both capabilities after opening resources in restore mode. See [operations](operations.md), [routing](routing.md), and the [standalone external example](../examples/external-code/README.md).
