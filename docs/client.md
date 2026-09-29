# TypeScript client

Use `@otp-router/client` from a trusted Node.js backend. Client `0.1.0` targets server `0.1.0` and its `/v1` API. Check the [release notes](releases.md) for supported pairings before upgrading.

The [package README](../packages/client/README.md) covers installation, configuration, errors, and timeouts; exported declarations define signatures and DTO fields. The [runnable example](../examples/client/README.md) exercises both capabilities with fake providers.

Follow the [HTTP idempotency contract](api.md#idempotency) and [project isolation rules](projects.md). Timeouts and cancellation do not undo durable server work. Use [history cursors](history.md) to reconcile retained evidence; the client does not poll or maintain projections.

Use `createAdminClient()` with an administrator Bearer token for provisioning, settings, lifecycle, grants, and audit. Read `result.etag` and pass it as `etag` on subsequent mutations. Backend clients still select one project; administrator clients select targets per operation. See the [administration example](../examples/admin/run.ts).
