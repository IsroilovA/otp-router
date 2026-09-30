# TypeScript client

Use `@otp-router/client` from a trusted Node.js backend. Client `0.2.0` targets server `0.2.0` and its `/v1` API. Check the [release notes](releases.md) for supported pairings before upgrading.

The [package README](../packages/client/README.md) covers installation, configuration, errors, and timeouts; exported declarations define signatures and DTO fields. The [runnable example](../examples/client/README.md) exercises both capabilities with fake providers.

Creation and preparation DTOs support the optional [integration reference](api.md#integration-correlation). Keep its original presence and value when retrying; response and history DTOs expose it when supplied.

Follow the [HTTP idempotency contract](api.md#idempotency) and [project isolation rules](projects.md). Timeouts and cancellation do not undo durable server work. Use [history cursors](history.md) to reconcile retained evidence; the client does not poll or maintain projections.

Use `createAdminClient()` with an administrator Bearer token for provisioning, settings, lifecycle, grants, and audit. Read `result.etag` and pass it as `etag` on subsequent mutations. Backend clients still select one project; administrator clients select targets per operation. See the [administration example](../examples/admin/run.ts).

The administrator client also exposes runtime commands, resource reads/listing, assignments, and audit. Persist each command with its idempotency key and original expected revision, especially for credential rotation. Secret values are write-only; returned resources and receipts contain version metadata. See the [provisioning example](../examples/admin/run.ts).
