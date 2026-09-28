# Public updates

Outbound events carry committed managed/external snapshots, attempt updates, and normalized attempt evidence. The [public event schemas](../packages/engine/src/notifications/history-contracts.ts) own their shape. Events omit codes, recipients, binding/context data, and raw provider payloads. A notification never substitutes for consuming a securely bound verification result.

## Ordering and reconciliation

Events can arrive before their HTTP response, out of order, repeatedly, or after expiry. Deduplicate every event by event ID. Apply only higher revisions when updating subject snapshots, including HTTP snapshots; retain evidence events independently. Each event is self-contained. [Attempt history and the project event feed](history.md) provide reconciliation beyond the latest operation snapshot.

## Authentication and ingestion

Configure one trusted backend destination in the deployment entry. Use HTTPS except for literal loopback in local development; container loopback refers to that container. Redirects are forbidden.

Use an independent signing secret and authenticate exact bytes and timestamp before decoding. The protocol follows [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md); provider callbacks and API credentials are separate.

The [receiver example](../examples/webhook-receiver/README.md) demonstrates authenticated ingestion. Commit the receipt and projection before acknowledging. If business effects cannot commit with the receipt, use a receiver-owned outbox. Keep deduplication receipts as long as replay is permitted; revision checks alone do not deduplicate side effects.

Generate a dedicated secret for the supplied configuration entry:

```sh
node -e 'process.stdout.write("whsec_" + require("node:crypto").randomBytes(32).toString("base64") + "\n")'
```

Store it securely in both sender and receiver. Never log event bodies or reserialize them before signature verification.

## Delivery and recovery

Any 2xx acknowledges delivery. Other responses, failures, and timeouts retry with bounded backoff; lost acknowledgements can duplicate delivery. Retries preserve event ID and body, with fresh authentication timestamps. Notification retries never authorize OTP sends.

Failed events remain available for investigation and replay after retry exhaustion. [History retention](history.md#retention-window) governs events, including when no destination is configured; pending/failed notifications survive subject cleanup. Enabling a destination affects subsequent transitions.

After repairing the receiver, follow [notification replay](operations.md#outbound-notifications). Replays use the current destination and signing secret; coordinate changes across roles and accept both secrets during rotation. Backups can restore already-delivered events and older revisions, so receiver deduplication must survive router recovery.
