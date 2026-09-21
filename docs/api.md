# HTTP integration

Applications call the router from their backend over a private network or TLS. Authenticate application endpoints with a deployment Bearer API key. Provider callbacks use provider-specific authentication instead.

The deployment key grants access to every challenge in that deployment. Keep it out of browsers and mobile clients. Your backend must bind each challenge to its own authorized user/session and business action; a challenge ID alone is not authorization.

Generate the wire reference from the endpoint schemas:

```sh
pnpm build
node apps/server/dist/main.js --openapi > openapi.json
```

Treat this output as generated. Change schemas and handlers together, then verify generation against HTTP behavior. For a Compose-only build, use `docker compose -f apps/server/compose.yaml run --rm --no-deps router node apps/server/dist/main.js --openapi > openapi.json`.

| Method and path | JSON body | Success |
| --- | --- | --- |
| `POST /v1/challenges` | Recipient, purpose, context ID, policy ID; example below | 201 challenge snapshot |
| `GET /v1/challenges/{challengeId}` | None; no idempotency key needed | 200 challenge snapshot |
| `POST /v1/challenges/{challengeId}/verify` | `{"code":"123456","purpose":"login","contextId":"example-flow-1"}` | 200 verification result |
| `POST /v1/challenges/{challengeId}/deliveries` | `{"action":"resend"}`, `{"action":"next"}`, or `{"action":"select","choice":{"type":"provider","providerInstanceId":"sms-main"}}` | 202 attempt ID and challenge snapshot |
| `POST /v1/challenges/{challengeId}/cancel` | `{}` | 200 challenge snapshot |

External delivery uses the same Bearer authentication, bounded bodies, request IDs and idempotency headers:

| Method and path | Body | Success |
| --- | --- | --- |
| `POST /v1/delivery-operations` | Recipient, purpose, contextId, policyId, absolute UTC `expiresAt`; optional locale/routing choice | 201 prepared snapshot |
| `POST /v1/delivery-operations/with-code` | Preparation body plus `code` | 201 snapshot with initial work queued |
| `GET /v1/delivery-operations/{operationId}` | None | 200 current delivery snapshot |
| `POST /v1/delivery-operations/{operationId}/code` | `{"code":"123456"}` | 202 attachment; 200 when already attached identically under a different key |
| `POST /v1/delivery-operations/{operationId}/deliveries` | resend/next/select action | 202 snapshot |
| `POST /v1/delivery-operations/{operationId}/close` | `{}` | 200 terminal snapshot |

External delivery has no verify endpoint or verified state. Preparation is durable handoff acceptance, not a capacity guarantee. Provider acceptance arrives asynchronously; the external authority performs recipient verification. Preserve the original deadline and code on retries and channel switches. Close after the external flow ends; closure cannot recall an in-flight message.

External mutations of a challenge-owned operation return `managed_operation` (409). Missing operations return 404, terminal code submission returns 410, conflicting attached codes return 409, and quotas/cooldowns return 429. Retained replay returns its original safe response without repeating sends; query status for current state. Challenge snapshots expose their `operationId`.

All mutations require JSON and an `Idempotency-Key`. The verification code above illustrates the string format; submit the user's received code, preserving leading zeros. Manual selection also accepts `{"type":"channel","channel":"sms"}` as its choice. It must be enabled by the policy.

## Integration flow

Use the [running guide](running.md) to start a local fake-provider deployment. The fake provider exercises acceptance and events without exposing a usable code.

Create a challenge with a recipient, purpose, context and policy. Retain its ID and creation idempotency key. Subscribe to [updates](webhooks.md), request delivery actions as needed, and submit the received code with the original purpose/context. Save and consume the returned verification result once in your backend. Cancel when the application flow ends without verification.

## Challenge operations

[Policy configuration](configuration.md#policies) determines managed lifetime and provider constraints. Creation fixes the absolute deadline; resends preserve it.

Creation accepts an international phone number, purpose, context ID, and policy. Optional locale, routing context, and initial delivery choice remain bounded by deployment configuration. Creation returns after durable work commits; it does not wait for a provider.

Creation, GET, cancellation, delivery results and webhooks share the exported snapshot schema.



| State | Meaning |
| --- | --- |
| `queued` | Initial durable delivery work awaits processing. |
| `sending` | Processing has begun, including automatic fallback. Fallback never regresses to `queued`. |
| `accepted` | At least one provider accepted a send whose acceptance has not been invalidated by confirmed final failure. This does not promise delivery. |
| `uncertain` | Acceptance remains unknown, with no valid confirmed acceptance. No automatic resend or fallback. |
| `verified` | The code was verified; final. |
| `failed` | No automatic attempts remain without acceptance, or the challenge ended without verification. |

Safe reasons are `expired`, `cancelled`, `locked`, `delivery_failed`, `delivery_uncertain`, `invalid_recipient`, `rate_limited`, and `provider_unavailable`; otherwise `reason` is null. Delivery failure alone can leave verification available until expiry. A failed or uncertain resend preserves an earlier still-valid acceptance. Authenticated late evidence can resolve uncertainty or invalidate acceptance. Terminal verification states never reopen.

`provider` is null until confirmed acceptance, then contains the saved instance `id` and configured display `label`; `channel` describes that acceptance. During a new send they can continue identifying the prior acceptance. There is no public attempt history or routing state.

`revision` increases only for meaningful committed snapshot changes. Reads refresh `serverTime` without revision churn; an overdue read can materialize the actual expiry transition once. Use GET for reconciliation, and [challenge.updated](webhooks.md) for normal updates. No follow-up fetch is required to interpret an event.

Action forecasts describe the last published transition. Use `availableAt` as an absolute earliest retry time, and `expiresAt`/`serverTime` for countdowns. A timed denial can be reconsidered once its deadline passes without waiting for a new event. Stop all actions at expiry. A deadline at or after expiry offers no useful retry window. Shared quotas, restrictions, and configuration can change independently, so every submitted action is revalidated. Neither a forecast nor `Retry-After` reserves capacity or extends validity.

Verification checks the supplied purpose and context before comparing the code. A successful response contains a stable verification ID and the stored binding. The adopting backend must consume that result for its intended business action only once.

Delivery actions and cancellation follow the [routing rules](routing.md). Cancellation suppresses pending work and erases secrets, but cannot recall a transmitted message.

## Idempotency

Every mutation requires an `Idempotency-Key` of one to 128 visible ASCII characters (`!` through `~`, without spaces). Use a random key for each intended action and retain it for retries. Do not embed codes or recipient information in keys.

Keys are scoped to deployment, operation, and target challenge where applicable. A matching replay returns the original status and body with `Idempotency-Replayed: true`. That snapshot may be stale; apply snapshots only when their revision exceeds the one already stored. Reconcile with GET when needed. A webhook can arrive before the creation response. Changed validated input conflicts with the saved operation.

Verification fingerprints separate the binding from the submitted code. While active, a changed code conflicts. After a terminal transition erases code fingerprints, a syntactically valid changed code can replay the original result if the key and non-code fields match. This creates no new verification.

Save failures that consume a guess or otherwise commit a result. Authentication errors, malformed input, rolled-back work, and transient quota/cooldown rejection do not complete an operation key. Retry those after resolving the condition.

After an ambiguous commit or lost response, retry the same key and payload. A request-in-progress response does not prove that the original request failed. Results remain replayable until retention cleanup removes them; clients must not deliberately recycle keys.

## Errors and callbacks

Application errors contain a stable code, safe message, and server-generated request ID. Parse the code, not the message. An incorrect-code response also distinguishes an active challenge from lockout. Retry times describe when a request may become eligible, not a promise of success.

Requests use strict schemas, bounded bodies, and duplicate-key rejection. Application responses are not cacheable. Never log request bodies or authorization headers.

Application JSON bodies are limited to 16 KiB. Common client decisions are:

| Response | Client action |
| --- | --- |
| 400 `invalid_request`, 413 `request_too_large`, 422 input/policy errors | Correct the input or configuration before retrying. |
| 401 `unauthorized` | Check the backend credential. |
| 404 `challenge_not_found`, 410 `challenge_unavailable` | Stop using that challenge and reconcile the application flow. |
| 409 `idempotency_conflict` | The key was used with different validated input; recover the original request. |
| 409 `request_in_progress` | Retry the same key and payload after a bounded delay. |
| 409 `challenge_state_conflict` | Read current status and reconcile the flow; do not blindly resubmit. |
| 422 `incorrect_code` | `error.reason: "locked"` ends further guesses; otherwise the code was incorrect while still active. |
| 429 `cooldown_active` or `rate_limited` | Respect `Retry-After` and optional `error.retryAt`; expiry stays fixed. |
| Lost response, 500, or 503 | Retry with bounded backoff using the same key and payload; the outcome may have committed. |

Callback endpoints authenticate raw bytes before ingesting normalized events. Acknowledge only after durable ingestion. Duplicate, early, and out-of-order reports cannot verify a challenge or repeat a routing transition. Custom handshake responses preserve the adapter's status, content type, and bytes; their protocol is defined by that adapter.
