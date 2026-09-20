# HTTP integration

Applications call the router from their backend over a private network or TLS. Authenticate application endpoints with a deployment Bearer API key. Provider callbacks use provider-specific authentication instead.

Generate the wire reference from the endpoint schemas:

```sh
pnpm build
node dist/main.js --openapi > openapi.json
```

Treat this output as generated. Change schemas and handlers together, then verify generation against HTTP behavior. The [running guide](running.md) includes a request example.

## Challenge operations

Creation accepts an international phone number, purpose, context ID, and policy. Optional locale, routing context, and initial delivery choice remain bounded by deployment configuration. Creation returns after durable work commits; it does not wait for a provider.

Read status to obtain verification state, delivery state, and action forecasts. Status does not contact providers. Use `expiresAt` and `serverTime` for countdowns. An action's availability time or `Retry-After` never extends validity.

Verification checks the supplied purpose and context before comparing the code. A successful response contains a stable verification ID and the stored binding. The adopting backend must consume that result for its intended business action only once.

Delivery actions and cancellation follow the [routing rules](routing.md). Cancellation suppresses pending work and erases secrets, but cannot recall a transmitted message.

## Idempotency

Every mutation requires a printable ASCII `Idempotency-Key` of one to 128 characters. Use a random key for each intended action and retain it for retries. Do not embed codes or recipient information in keys.

Keys are scoped to deployment, operation, and target challenge where applicable. A matching replay returns the original status and body with `Idempotency-Replayed: true`. That snapshot may be stale; read status when current state is needed. Changed validated input conflicts with the saved operation.

Verification fingerprints separate the binding from the submitted code. While active, a changed code conflicts. After a terminal transition erases code fingerprints, a syntactically valid changed code can replay the original result if the key and non-code fields match. This creates no new verification.

Save failures that consume a guess or otherwise commit a result. Authentication errors, malformed input, rolled-back work, and transient quota/cooldown rejection do not complete an operation key. Retry those after resolving the condition.

After an ambiguous commit or lost response, retry the same key and payload. A request-in-progress response does not prove that the original request failed. Results remain replayable until retention cleanup removes them; clients must not deliberately recycle keys.

## Errors and callbacks

Application errors contain a stable code, safe message, and server-generated request ID. Parse the code, not the message. An incorrect-code response also distinguishes an active challenge from lockout. Retry times describe when a request may become eligible, not a promise of success.

Requests use strict schemas, bounded bodies, and duplicate-key rejection. Application responses are not cacheable. Never log request bodies or authorization headers.

Callback endpoints authenticate raw bytes before ingesting normalized events. Acknowledge only after durable ingestion. Duplicate, early, and out-of-order reports cannot verify a challenge or repeat a routing transition. Custom handshake responses preserve the adapter's status, content type, and bytes; their protocol is defined by that adapter.
