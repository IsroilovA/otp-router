# HTTP integration

Call the router from an authorized backend over a private network or TLS. A configured backend service principal authenticates with a Bearer credential and explicit project grants; never expose that credential to browsers or mobile clients. See [project authentication and isolation](projects.md). Your backend must bind each operation to its authorized user/session and business action. An operation ID alone is not authorization.

TypeScript backends can use the [typed client](client.md), which follows this same HTTP contract.

Endpoint schemas own paths, request/response shapes, validation limits, and status codes. Generate their reference after building:

```sh
node apps/server/dist/main.js --openapi > openapi.json
```

## Integration flow

Choose [managed verification or external delivery](engine.md). Create, retain the operation ID and request key, then observe [public updates](webhooks.md). Creation acknowledges durable work, not provider acceptance. The local fake provider accepts sends without delivering a usable code.

The [HTTP walkthrough](../examples/http/README.md) runs both flows against the local server and shows a same-key replay after an ambiguous response.

For managed verification, submit the received code with its original purpose/context and preserve leading zeros. Consume the successful result once in your backend. Cancel when the flow ends without verification.

For external delivery, preserve the upstream deadline and attached code across channel changes. Close when the upstream flow ends; delivery status never authenticates the recipient.

## Status and action forecasts

Acceptance means a provider accepted a send, not that the recipient received it. Delivery failure can leave verification available until its deadline and guess limit. A failed resend cannot erase another still-valid acceptance. Terminal verification states never reopen.

Public provider/channel describe confirmed acceptance, not route selection. During another send they may still identify the earlier acceptance. Use the separate [attempt history and event feed](history.md) for complete retained evidence.

Revisions advance for meaningful committed changes. Reads refresh server time without revision churn, though an overdue read can materialize expiry once. A webhook can arrive before its HTTP response; apply only higher revisions for the same subject and event kind.

Action forecasts describe the last published transition. Use absolute retry/expiry times and server time for countdowns. A timed denial can be reconsidered after its deadline without another event. Forecasts and retry headers neither reserve capacity nor extend expiry; every action is revalidated. See [routing](routing.md).

## Idempotency

Use a fresh random `Idempotency-Key` for each intended mutation and retain it with the payload for retries. Do not embed secrets or deliberately recycle keys. Keys are scoped to deployment, project, operation, and target where applicable; changed validated input conflicts with a saved request.

A matching replay returns the original status/body, marked by `Idempotency-Replayed`. The snapshot can be stale; use revisions and status reads to reconcile.

Verification compares the binding separately from the code. While active, a changed code conflicts. After a terminal transition erases code fingerprints, a syntactically valid changed code can replay the original result if the key and non-code fields match; this creates no new verification.

Wrong guesses and other committed outcomes complete the request key. Authentication failures, malformed input, rolled-back work, and transient quota/cooldown rejection do not. Replays consume no additional guesses or sends.

After a lost response, ambiguous commit, or server error, retry with bounded backoff using the same key and payload. An in-progress response does not prove failure. Respect retry deadlines; a state conflict calls for status reconciliation, and an input conflict calls for recovering the original request.

## Errors and callbacks

Branch on stable error codes, never message text. Lockout ends further guesses; an ordinary incorrect guess does not. Expired/cancelled operations cannot resume. Responses must be non-cacheable and free of sensitive details; never log request bodies or authorization headers.

Provider callbacks use independent authentication over bounded raw bytes. Acknowledge only after durable ingestion. Duplicate, early, or out-of-order reports cannot verify a challenge or repeat a routing transition. Each adapter owns its handshake protocol.
