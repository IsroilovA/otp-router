# Engine integration

Use `@otp-router/engine` for resources and control, `/challenges` for managed verification, `/delivery` for external code delivery, `/config` for settings and selectors, and `/providers` for adapters. Exported TypeScript contracts define request, result and event shapes. Consumers resolve built exports; private records and SQL helpers are unsupported imports.

## Resource lifecycle

Load a `Configuration` with `loadConfiguration` in a scope. Pass the result and a redacted database URL to `makeEngineLayer`, supplying platform services such as `NodeServices.layer`. Resource construction migrates and validates the database and starts pg-boss. Imports open no resources.

Start workers through `EngineControl.startWorkers` in a nested scope. API-only callers need not start workers. The caller owns signals, readiness and shutdown: stop traffic and claims, drain work, then close resources. `probe` checks database availability.

## Choosing a capability

Use `Router` when the router should generate and verify codes. Create a challenge, accept its delivery updates, and verify against the original purpose/context binding. The adopting application owns authorization and consumes the verification result once; see [security](security.md).

Use `Delivery` when another authority generates and verifies codes:

1. `prepare` fixes the recipient, route and absolute deadline without a code. Preparation reserves no future provider capacity.
2. `submitCode` attaches a code once and queues delivery. Identical submissions do not create another attempt; a replacement code requires a new operation. `create` combines these steps.
3. `status` reads a redacted snapshot; `deliver` requests resend, next or selection according to [routing rules](routing.md).
4. `close` ends the operation. Closed and expired operations never reopen, and an in-flight message cannot be recalled.

External methods cannot mutate challenge-owned operations. Delivery outcomes do not prove recipient verification. See the [external-code example](../examples/external-code/README.md).

## Results and control

Both capabilities return tagged domain errors. Incorrect guesses are committed results so replay does not consume another guess. Retained replay returns the original result, which may describe an earlier state; use status for reconciliation. See [idempotency](api.md#idempotency) and [transaction guarantees](data-model.md).

Subscribe to [public events](webhooks.md) for changes. `EngineControl.replayNotification` requeues a retained failed event; restore invalidation is an operator procedure described in [operations](operations.md).
