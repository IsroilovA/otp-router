# Public updates

Configure `engine.settings.webhook = { url, signingSecret }` to send meaningful public changes to one backend destination. `challenge.updated` carries a managed challenge snapshot; `delivery.updated` carries a delivery snapshot. A managed operation can produce both. Exported event schemas define their shapes.

Events omit codes, recipients, context/binding data, raw provider payloads and attempt history. A verification notification is not a substitute for consuming the securely bound result from the verify endpoint.

## Ordering and reconciliation

A webhook may arrive before its HTTP response, out of order, more than once, or after expiry. Deduplicate by `eventId` and apply only higher revisions for each `(type, subject ID)`, including snapshots from HTTP responses. Never compare revisions across subjects or event kinds.

Each event describes the committed snapshot and needs no follow-up fetch. Retry preserves its ID and body. Use GET for reconciliation and [absolute deadlines and action forecasts](api.md#challenge-operations) for client behavior.

## Configuration and authentication

The supplied configuration examples read `OTP_ROUTER_WEBHOOK_URL` and `OTP_ROUTER_WEBHOOK_SIGNING_SECRET`. Generate a dedicated secret:

```sh
node -e 'process.stdout.write("whsec_" + require("node:crypto").randomBytes(32).toString("base64") + "\n")'
```

Store it in the deployment secret store and share it only with the receiver. HTTPS is required except on local loopback. In Docker, loopback is the router container itself; use a TLS destination to reach another host. Redirects are rejected. The destination is trusted deployment configuration, never request input.

The sender follows [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md), signing the event ID, current Unix timestamp and exact stored bytes. Headers are `webhook-id`, `webhook-timestamp` and `webhook-signature`. Each retry gets a fresh timestamp/signature. Provider callback authentication and API credentials are independent.

## Receiver

The [TypeScript receiver example](../examples/webhook-receiver/receiver.ts) authenticates raw bytes, validates either event type, and commits the receipt plus highest-revision projection in one application-database transaction. Its `applySnapshot` also handles HTTP responses.

At the HTTP boundary, read a bounded raw UTF-8 body, pass the signature headers, and acknowledge only after durable ingestion. Reject authentication/schema failures; return 503 for persistence failures. Never log the body or parse and reserialize it before signature verification.

Keep deduplication receipts for as long as replay is permitted. Highest-revision application protects projections but does not replace deduplication for business side effects. If those effects cannot commit with the receipt, write a receiver-owned outbox in the same transaction.

## Delivery and recovery

Notification retries are independent of OTP dispatch. Any 2xx acknowledges; other responses, transport failures and timeouts retry with bounded exponential backoff. Interrupted sends and missing queue jobs recover through startup and maintenance. Lost acknowledgements can duplicate delivery. Run a worker even in an API-only deployment.

After exhaustion, failed events remain for investigation and replay. Delivered events retain seven days after acknowledgement; pending/failed events survive subject-history cleanup. Without a configured destination, events retain seven days without notifications. Enabling a destination affects subsequent transitions.

Inspect `otp_router.notifications` joined by `event_id` to `otp_router.events` for failed or overdue work. After fixing the receiver, replay a failed event:

```sh
node --env-file=.env apps/server/dist/main.js --config "$PWD/examples/config/router.config.ts" --replay-webhook EVENT_UUID
```

Replay resets the notification attempt budget and requeues its original ID/body. It never sends an OTP. Retried events use the current destination and signing secret: coordinate destination changes across roles and temporarily accept both secrets during rotation.
