# Durable webhook receiver

[receiver.ts](receiver.ts) validates public history events, deduplicates receipts, and updates managed/external snapshots. Attempt updates and evidence remain in its receipt journal. Install its tables using your application's migrations. Other languages can use the outbound webhook schemas in the [OpenAPI reference](../../docs/api.md).

Your HTTP handler must await `receiveWebhook({ secret, body, headers })` with its database layer before returning 204. Supply the exact raw UTF-8 request body and Standard Webhooks headers; no Bearer token is needed. Reject bad authentication/schema input and return 503 on database failure. Limit the request body (64 KiB is sufficient for these bounded snapshots).

Receipts and the highest-revision projection commit together. Duplicate event IDs do nothing. Older events cannot overwrite newer revisions. Apply the creation response through `applySnapshot` for managed challenges or `applyDeliverySnapshot` for external deliveries too, because notifications can arrive before that response. Use a receiver outbox for business work that cannot commit in the receipt transaction. See [the protocol and operational guide](../../docs/webhooks.md).
