# Public updates

Outbound events carry committed managed or external-delivery snapshots. The [challenge](../packages/engine/src/challenges/contracts.ts) and [delivery](../packages/engine/src/delivery/contracts.ts) schemas own their shape. Events omit codes, recipients, binding/context data, raw provider payloads, and attempt history. A notification never substitutes for consuming a securely bound verification result.

## Ordering and reconciliation

Events can arrive before their HTTP response, out of order, repeatedly, or after expiry. Deduplicate by event ID and apply only higher revisions for the same subject and event kind, including HTTP snapshots. Each event is self-contained; status reads provide reconciliation when needed.

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

Failed events remain available for investigation and replay after retry exhaustion. Delivered events retain seven days after acknowledgement; pending/failed events survive subject-history cleanup. Without a configured destination, events retain seven days without notifications. Enabling a destination affects subsequent transitions.

After repairing the receiver, follow [notification replay](operations.md#outbound-notifications). Replays use the current destination and signing secret; coordinate changes across roles and accept both secrets during rotation. Backups can restore already-delivered events and older revisions, so receiver deduplication must survive router recovery.
