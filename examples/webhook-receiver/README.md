# Durable webhook receiver

[receiver.ts](receiver.ts) is an Effect/PostgreSQL integration example for your backend, covered by the router's integration tests. Install its tables once using your migration system. It imports the event schema from this checkout; applications can generate their equivalent from the outbound webhook section of `node dist/main.js --openapi`.

Your HTTP handler must await `receiveWebhook({ secret, body, headers })` with its database layer before returning 204. Supply the exact raw UTF-8 request body and Standard Webhooks headers; no Bearer token is needed. Reject bad authentication/schema input and return 503 on database failure. Limit the request body (64 KiB is sufficient for these bounded snapshots).

Receipts and the highest-revision projection commit together. Duplicate event IDs do nothing. Older events cannot overwrite newer revisions. Apply the creation response through `applySnapshot` too, because notifications can arrive before that response. Use a receiver outbox for business work that cannot commit in the receipt transaction. See [the protocol and operational guide](../../docs/webhooks.md).
