# TypeScript client

Use `@otp-router/client` from a trusted Node.js backend. Client `0.0.1` targets server `0.0.1` and its `/v1` API. Check the [release notes](releases.md) for supported pairings before upgrading.

The [package README](../packages/client/README.md) covers installation, configuration, errors, and timeouts; exported declarations define signatures and DTO fields. The [runnable example](../examples/client/README.md) exercises both capabilities with fake providers.

Follow the [HTTP idempotency contract](api.md#idempotency) and [project isolation rules](projects.md). Timeouts and cancellation do not undo durable server work. Use [history cursors](history.md) to reconcile retained evidence; the client does not poll or maintain projections.
