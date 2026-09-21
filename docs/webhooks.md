# Outbound challenge updates

Configure `engine.settings.webhook = { url, signingSecret }` to send every creation and meaningful public snapshot change to one backend destination. The only event type is `challenge.updated`. Its `challenge` has exactly the same schema as creation and reconciliation GET; it needs no follow-up fetch. Events omit codes, recipients, context/binding data, provider payloads, and attempt history. Successful verification still returns its separate verification ID and purpose/context binding through the authenticated verify endpoint.

```json
{"eventId":"ea6890d0-c9e9-4dd3-9f6a-800f5cc2bc26","type":"challenge.updated","occurredAt":"2026-09-21T12:00:02.000Z","challenge":{"challengeId":"6bd2b39a-11ac-4fc7-bc02-d928d6929532","revision":3,"state":"accepted","reason":null,"channel":"telegram","provider":{"id":"telegram-main","label":"Telegram"},"expiresAt":"2026-09-21T12:05:00.000Z","serverTime":"2026-09-21T12:00:02.000Z","actions":{"verify":{"allowed":true},"resend":{"allowed":false,"reason":"cooldown_active","availableAt":"2026-09-21T12:00:31.000Z"},"next":{"allowed":false,"reason":"no_next_provider"},"select":{"allowed":false,"reason":"manual_selection_disabled","choices":[]},"cancel":{"allowed":true}}}
```

Creation remains HTTP 201 after durable commit, before provider dispatch. A webhook may arrive before the creation response. Apply only higher revisions, including when processing HTTP responses. Events can arrive out of order, more than once, or after expiry. Use `eventId` for durable deduplication, `revision` for ordering, and the fixed `expiresAt` to stop actions locally even while an expiry event is delayed. `occurredAt`/`serverTime` describe the committed projection; retries do not change them. Read GET only for reconciliation. See [states and action forecasts](api.md#challenge-operations).

## Configuration and authentication

Both supplied configuration examples read `OTP_ROUTER_WEBHOOK_URL` and, when set, `OTP_ROUTER_WEBHOOK_SIGNING_SECRET`. Generate a dedicated secret with:

```sh
node -e 'process.stdout.write("whsec_" + require("node:crypto").randomBytes(32).toString("base64") + "\n")'
```

Store it in the deployment secret store and share it only with the receiver. HTTPS is required; HTTP is allowed on `localhost`, `127.0.0.1`, and `[::1]` for local testing. In Docker, loopback is the router container itself; use a TLS destination to reach another host. Redirects are rejected. The destination is trusted deployment configuration, never request input. No additional Bearer token is sent.

The sender uses the official [`standardwebhooks` package, pinned at 1.1.1](https://www.npmjs.com/package/standardwebhooks/v/1.1.1), following the [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md). It signs event ID, current Unix timestamp, and exact stored body bytes. Headers are `webhook-id`, `webhook-timestamp`, and `webhook-signature` (`v1,<base64-signature>`). Every attempt gets a fresh signing timestamp/signature; the event ID and body stay unchanged. Provider callback authentication and the API Bearer key are independent.

## Receiver

[The TypeScript receiver example](../examples/webhook-receiver/receiver.ts) uses `new Webhook(secret).verify(rawBody, headers)`, validates the authenticated event with Effect Schema, and commits its receipt plus highest-revision projection in one application-database transaction. It also exposes `applySnapshot` for creation responses, so a delayed HTTP response cannot overwrite a newer webhook.

Install its two tables through your application's migrations. At your HTTP boundary, read a bounded raw UTF-8 body, pass the three signature headers, run `receiveWebhook` with your database layer, and respond 204 only after it succeeds. Reject authentication/schema failures; return 503 for persistence failures so the router retries. Never acknowledge before the durable receipt commits, log the raw body, or parse and reserialize before signature verification. Do not interpret a `verified` notification as a substitute for consuming the securely bound verification result once.

Keep receipt IDs for at least as long as you permit replay. Failed events can be replayed much later; highest-revision application provides another guard but does not replace deduplication for business side effects. If effects cannot commit with the receipt, write a receiver-owned outbox in that same transaction.

## Delivery and recovery

Events and notification jobs commit with the originating challenge change. Nested provider outcomes publish one coherent result, without intermediate states from the same transaction. Duplicate callbacks without public changes, internal bookkeeping, and countdown ticks produce no events. Expiry has a scheduled job and a cleanup recovery path. API-only deployments need a worker to deliver notifications and scheduled expiry updates.

The independent notification queue uses a 10-second request timeout, a 30-second claim lease, and at most 12 HTTP attempts. Retry delays start at 5 seconds and double to a 1-hour cap. Any 2xx acknowledges; other status codes, transport failures, and timeouts retry. Retry-After does not override the bounded schedule. No transaction spans HTTP. Interrupted attempts recover after lease expiry; startup and the minute maintenance sweep re-enqueue due work if a queue job was lost. This is at-least-once delivery, so a lost acknowledgement can duplicate an already received event.

After exhaustion, the event and safe notification diagnostics remain indefinitely for investigation/replay. Delivered events are cleaned seven days after acknowledgement; pending/failed events survive challenge-history cleanup. When no destination is configured, events still persist for seven days but no notification is scheduled; enabling a destination affects subsequent transitions.

Inspect `otp_router.notifications` (`state`, `attempts`, `next_attempt_at`, `lease_until`, `last_status`, `last_failure`) joined by `event_id` to `otp_router.events`. Diagnoses are `http_error`, `transport_error`, or `worker_recovery`; no response bodies or transport errors are retained. Monitor failed rows and overdue pending/leased rows. After fixing the receiver, replay one failed event:

```sh
node --env-file=.env apps/server/dist/main.js --config "$PWD/examples/config/router.config.ts" --replay-webhook EVENT_UUID
```

Replay resets its notification attempt budget and requeues its original ID/body. It never changes the challenge or sends an OTP. Run a worker to deliver it. During signing-secret rotation, have the receiver temporarily accept old and new secrets, then update every router role. Retried old events use the current secret. Destination changes also apply to outstanding notifications, so coordinate them across roles.

## Event kinds

The shared event store and worker publish `challenge.updated` with a `challenge` snapshot and `delivery.updated` with a `delivery` snapshot. Each has eventId, occurredAt and its subject's increasing revision. Delivery revisions and challenge revisions are independent. Receivers deduplicate by event ID and apply snapshots by `(type, subject ID, revision)`; they must not compare revisions across subjects or kinds.

A managed operation can produce both event kinds. External delivery snapshots never have a verify action or verified state. Queued work means durable handoff; accepted means provider evidence; neither proves recipient verification. The receiver example authenticates, records and projects both typed bodies in one transaction.
