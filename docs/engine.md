# Managed and external capabilities

The self-hosted HTTP server exposes managed verification and external-code delivery. Integrate through the [HTTP contract](api.md). The private engine package shares behavior between HTTP handlers, workers, and callbacks; it is not a separately released SDK. [Package exports](../packages/engine/package.json) also support trusted deployment extensions, as shown in the [custom adapter](../examples/custom-adapter/README.md).

## Managed verification

The router generates a code and checks it against the original purpose and context. The adopting backend authorizes the business action and consumes a successful verification result once. Provider acceptance or delivery alone never proves verification. See [security](security.md).

## External delivery

1. Prepare an operation with a recipient, route, and fixed deadline. Preparation accepts the handoff durably but reserves no future provider capacity.
2. Attach a code once, or create with a code in one action. Identical attachments do not create another send; replacing the code requires a new operation.
3. Observe status and request delivery actions under the [routing rules](routing.md).
4. Close when the upstream flow ends. Closed or expired operations never reopen; closure cannot recall an in-flight message.

External callers own code generation, verification, authorization, and association with their upstream flow. External methods cannot mutate challenge-owned operations and never produce an authentication claim.

## Integration obligations

Deployments own worker startup, readiness, and shutdown. API-only processes require a worker elsewhere for delivery and cleanup. Importing engine packages starts no resources.

Use [public events](webhooks.md) for committed changes, status reads for snapshots, and [attempt history](history.md) for complete retained evidence and feed reconciliation. Replayed results may describe an earlier state; follow [idempotency](api.md#idempotency). Operational recovery follows the [operations guide](operations.md).
