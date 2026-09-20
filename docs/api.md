# API design

Status: implemented. `node dist/main.js --openapi` exports the generated OpenAPI document. See [implementation evidence](implementation-evidence.md).

## Accepted access model

Applications call from their backend using `Authorization: Bearer <key>`. Browsers and mobile clients call that backend, which binds requests to the user's login or action.

Load one API key from deployment secrets, allowing at most two equally privileged keys during [rotation](operations.md#application-api-key-rotation). Authenticate before reading challenge state. Rotation preserves challenges, quotas, policies, and idempotency identities. V1 has no application users, roles, per-key permissions, or key-management API.

Provider callbacks use separate endpoints and provider-specific authentication.

## Request behavior

Create and delivery actions return after state changes, delivery records, queue jobs, and idempotency results commit together. Workers contact providers later. Success means queued work; subsequent provider failure changes delivery status, not the committed HTTP response.

Every mutation requires an `Idempotency-Key`; status reads do not. Reuse a key for the same operation and generate a new key for a new user action. See [replay rules](#idempotency-rules).

Check expiry, terminal state, and limits atomically. Revalidate submitted actions even when a prior snapshot allowed them. Delivery exhaustion does not disable verification. Cancellation blocks verification and pending sends but cannot recall dispatched requests.

## Accepted status access

Applications may read the authenticated status endpoint for delivery updates. V1 has no outgoing application webhooks, WebSockets, or server-sent events. Authenticated incoming provider callbacks update stored delivery state.

Verification returns its result synchronously. It requires neither status polling nor delivery confirmation.

## Accepted verification result

Return a JSON result bound to the original challenge, purpose, and context. The router does not create accounts, sessions, or login tokens.

| Field | Origin and meaning |
| --- | --- |
| `verificationId` | Router-generated identifier persisted with the successful verification transition. |
| `challengeId` | Router-generated identifier assigned when the challenge was created. |
| `purpose` | Backend-supplied value stored at creation, validated against configured purposes and permitted policies, and checked again for a match during verification. Return the stored value. |
| `contextId` | Backend-supplied opaque identifier for the specific login or business action, stored at creation and checked for a match during verification. Return the stored value. |
| `verifiedAt` | Database timestamp persisted when verification succeeds. |

Compare purpose and context before checking the code. Return stored values. Replay preserves the verification ID, binding, and timestamp.

The application must consume the bound business action once, using its own unique consumption record or transaction. Replaying verification does not authorize repeating that action.

Do not treat reading a challenge's verified status, possession of its identifier, or a provider's delivery callback as a new authorization result.

## Contract documentation

Generate OpenAPI from the service definitions and provide backend HTTP examples in TypeScript and another language. Document all operations with request fields, errors, idempotency behavior, state preconditions, and side effects. Provider callbacks need separate examples because their payloads and signature schemes differ.

## Accepted HTTP endpoints

All application routes use `Authorization: Bearer <server-api-key>`. Mutations require an `Idempotency-Key` header. Requests and responses use JSON with camelCase fields. Timestamps are UTC ISO 8601 strings. Identifiers are opaque strings; clients must not parse their internal format. Response bodies and authorization headers must not be cached or logged by default.

| Method and path | Input | Success |
| --- | --- | --- |
| `POST /v1/challenges` | Create input below. | `201`, a committed challenge snapshot with initial delivery work queued. |
| `GET /v1/challenges/{challengeId}` | Challenge ID. | `200`, the current challenge snapshot. |
| `POST /v1/challenges/{challengeId}/verify` | `code`, `purpose`, `contextId`. | `200`, the verification result. |
| `POST /v1/challenges/{challengeId}/deliveries` | One delivery action below. | `202`, `deliveryId` and a challenge snapshot after scheduling. |
| `POST /v1/challenges/{challengeId}/cancel` | Empty object. | `200`, the cancelled challenge snapshot. |

Separate provider routes use `/webhooks/{providerInstanceId}` with adapter-defined methods, raw-body validation, authentication, and acknowledgement responses. They do not inherit the application API key or idempotency header contract. Unknown instances do not create dynamic adapters.

### Create input

The router generates the code, challenge ID, and expiry; callers cannot supply them. The selected policy must be permitted for the purpose.

| Field | Contract |
| --- | --- |
| `recipient` | Required object with `type: "phone"` and `phoneNumber` in international form with `+` and country code. Under D101, parse and validate with a maintained phone-number library, then normalize to E.164 before routing and recipient quota lookup. Reject ambiguous local numbers without guessing a country. |
| `purpose` | Required configured purpose identifier, such as `login`. Configuration controls which policies that purpose may use. |
| `contextId` | Required opaque identifier for the adopting application's login or action flow. It must not contain a phone number, email, or free-form business payload. |
| `policyId` | Required name of a permitted startup policy. Clients cannot supply policy code or provider configuration. |
| `locale` | Optional locale identifier; use the global `defaultLocale` when absent. Resolve each provider using the global `fallbackLocales` order and persist the selected template and locale under D072. Provider languages may differ within one challenge. |
| `deliveryChoice` | Optional tagged choice of channel or provider instance. Allowed only when manual selection is enabled and the option is permitted by the route returned by the selector and the policy. Validate after route selection. |
| `routingContext` | Optional bounded object of primitive values for a configured routing selector. It comes from trusted backend code, is excluded from logs, and is not persisted as arbitrary challenge metadata. |

Resolve the route and every selected provider's template before committing. Missing coverage rejects creation without dropping providers. Selector rejection returns `delivery_unavailable`; failure, timeout, or an invalid route creates no challenge or job and never substitutes a default route. Save the [policy snapshot](data-model.md#persisted-snapshot-and-queue-versions). Completed replays reuse it without rerunning the selector.

[Boundary validation](#boundary-validation-and-ordering) defines field and body limits. Reject excess input; never truncate it. Configure webhook limits separately for provider batch formats.

### Delivery actions

Under D096, use one tagged action per request to the deliveries endpoint:

```json
[
  { "action": "resend" },
  { "action": "next" },
  { "action": "select", "choice": { "type": "channel", "channel": "sms" } },
  { "action": "select", "choice": { "type": "provider", "providerInstanceId": "sms-primary" } }
]
```

Submit one object, not the array. Creation uses the same choice format in `deliveryChoice`. A channel choice resolves the first eligible matching instance in policy order. Resend targets the current provider, including after automatic fallback. Each new action creates a delivery record while preserving the code, deadline, and failed-guess count. The application controls which choices it exposes; the router enforces [routing eligibility](routing.md#accepted-manual-selection) and rechecks state and budgets at dispatch.

### Challenge snapshot

Return `challengeId`, `purpose`, `contextId`, `createdAt`, `expiresAt`, `serverTime`, and `verificationState`. Include `verifiedAt` only after successful verification. Never return the code, code verifier, recoverable secrets, raw provider errors, or the full recipient number.

The `delivery` object contains the current `deliveryId`, `channel`, normalized delivery state, and routing condition. Routing conditions distinguish `pending`, `waiting`, `exhausted`, and `blocked`. A delivered record can coexist with an active verification state. Exhausted delivery never substitutes for a terminal verification state.

The `actions` object describes `verify`, `resend`, `next`, `select`, and `cancel`. Each has `allowed`, a stable reason when denied, and `availableAt` only when a future eligibility time is known. Manual choices use configured labels and permitted channel or instance IDs. Listing an option is not evidence of the recipient having an account on that channel. No action forecast reserves budget or promises future eligibility. `expiresAt` is the fixed verification deadline; `serverTime` supports the client countdown. An action's `availableAt` and a rejection's `Retry-After` describe when another request may be allowed, never an extension of code validity.

The adopting backend decides which snapshot fields its client needs. It must authenticate or bind the original flow before forwarding actions; possession of a challenge ID does not establish end-user authorization.

### Verification result and cancellation

Persist the [verification result](#accepted-verification-result) with the single transition to `verified`.

A correct submission with a new idempotency key after verification does not produce another successful result. Only a replay of the original successful operation can retrieve that result through verification. Reading status is observational.

Cancellation of an active challenge commits `cancelled`, deletes code secrets, and invalidates pending sends. Cancelling an already cancelled challenge is a successful no-op. A new cancellation request cannot replace `verified`, `locked`, or `expired`; return a state-conflict error. Replaying a completed cancellation returns its original result.

## Idempotency rules

Scope a key to this deployment, the operation, and the target challenge where applicable. Scope does not include the API credential ID, so credential rotation does not create a new operation. Create has no target challenge in its scope. Clients use a new random key for each intended operation and reuse it only when retrying that operation.

Fingerprint validated fields with deterministic ordering and a keyed digest. For verification, fingerprint `purpose` and `contextId` separately from `code`. Scope both digests to the operation and challenge. Keep the code fingerprint only while the challenge is active. Never persist a submitted code or an unkeyed code hash. Include transient routing context in a create fingerprint.

Commit the operation result and state changes together. Matching replays return the saved HTTP status and body with `Idempotency-Replayed: true`, without repeating any mutation or consuming a guess. Changed validated input returns `409 idempotency_conflict`, subject to the terminal-verification exception below.

When verification, cancellation, lockout, or expiry ends a challenge, erase all its code fingerprints with its OTP secrets. A terminal verification replay matches the original operation key and non-code fields, then returns the stored result without comparing the submitted code. A changed, syntactically valid code therefore does not cause a conflict on that terminal replay. It cannot create a new verification or change the old result. A new key still receives the terminal-state error. Enforce this rule for logical expiry even if cleanup has not run. See [lock ordering](data-model.md#transaction-order).

Replay returns the original response snapshot, which may now be stale. Its absolute timestamps remain unchanged. Clients read current status when needed. Replaying creation or verification after expiry never revives the challenge or creates a second business authorization.

Persist failures that commit domain changes, including consumed incorrect guesses and lockout. Do not persist completed results for authentication errors, malformed input, rolled-back transactions, or transient rejections that changed no state. Callers may retry those after resolving the condition. A lost commit response requires reconciliation by the same key because the mutation may have committed.

Concurrent requests wait up to 2,000 ms for the same operation identity. Replay a matching completed result; otherwise return `409 request_in_progress` without additional side effects. Retry with the same key and payload. The timeout does not prove that the first operation failed.

Retain results for at least twenty-four hours and longer while related work remains active. Replay remains available until actual cleanup. After deletion, key reuse is a new operation subject to current validation and limits; it may create a challenge but cannot revive a terminal one. Clients must not intentionally recycle keys.

## Accepted HTTP status mapping

Under D098, return an `error` object containing a stable `code`, safe developer-facing `message`, and diagnostic `requestId`. The message is not a stable parsing contract or a guaranteed UI translation. Include `retryAt` only when a future retry time is known. Rate and cooldown responses also set `Retry-After`; this indicates when another attempt may be allowed, not guaranteed success or extended code validity. Never expose a provider response, stack trace, submitted code, credential, or private account-membership inference.

| HTTP status | Error codes and meaning |
| --- | --- |
| `400` | `invalid_request`, including missing idempotency key or malformed fields. |
| `401` | `unauthorized`, for absent or invalid server credentials. |
| `404` | `challenge_not_found`, including an unknown ID or mismatched purpose/context binding. |
| `409` | `idempotency_conflict`, `request_in_progress`, or `challenge_state_conflict`. |
| `410` | `challenge_unavailable`, when verification targets an expired, locked, or cancelled challenge. |
| `413` | `request_too_large`. |
| `422` | `incorrect_code`, `invalid_recipient`, `delivery_option_not_allowed`, `policy_not_allowed`, or `delivery_unavailable`. |
| `429` | `rate_limited` or `cooldown_active`, without consuming another guess or scheduling another send. |
| `500` | `internal_error`, for unexpected programming defects. Return a safe generic message and diagnostic request ID. |
| `503` | `temporarily_unavailable`, including unavailable persistent enforcement. No unrestricted fallback path. |

The incorrect submission that reaches the challenge guess limit still returns `incorrect_code` and reports the resulting locked state. Subsequent submissions receive `challenge_unavailable`. An active aggregate recipient limit takes precedence over code comparison; correct guesses cannot bypass it. Exact validation and state-check ordering must have concurrency tests.

Keep defects and interruption distinct from expected failures. A defect must not become an incorrect-code result or authorize fallback. It does not prove a send or commit failed; persisted recovery and idempotency determine the outcome.

## Internal operation mapping

HTTP handlers call the shared core's create, status, verify, delivery, and cancel operations. Exhaustively map tagged domain failures to the HTTP envelope; never branch on message text. Multiple internal failures may share a public error to avoid exposing private distinctions. Keep lifecycle logic in the core and construct its dependencies once per process.

## Boundary validation and ordering

Require `application/json` for application mutation bodies. Reject unknown fields, duplicate JSON member names, arrays in place of objects, non-finite numbers, and implicit type coercions with `400 invalid_request`. Do not trim opaque identifiers or coerce a numeric OTP to text. Enforce the 16 KiB limit while reading bytes, including requests without `Content-Length`. Reject compressed application request bodies in v1. Provider callback routes use their own bounded raw-body parser.

Configured identifiers use ASCII letters, digits, `_`, and `-`, with length 1 to 64. Context IDs and idempotency keys are opaque printable ASCII strings of length 1 to 128 with no whitespace. Locale keys use exact case-sensitive configured spelling, have length 1 to 64, and use ASCII letters, digits, and hyphens. An unconfigured requested locale can still resolve through explicit fallbacks. `routingContext` is a flat JSON object whose values are strings, finite numbers, booleans, or null, limited to 4 KiB of UTF-8 serialized JSON. Reject nested objects and arrays. Validate OTP input as 6 to 8 ASCII digits; after binding an active challenge, require its configured length before comparison. Invalid syntax or length consumes no guess.

Apply these stages in order, retaining the lock order in the data model:

1. Enforce transport limits and authenticate the API key before looking up challenge data. Compare fixed-length digests of supplied and configured high-entropy keys using constant-time comparison. Never log the header. Generate a server request ID independently of untrusted caller headers.
2. Validate the request shape, path, and operation key. Normalize the phone for creation. Fingerprint validated input with recursively sorted object keys, preserved array order, and explicit separation of absent fields from supplied values. Completed creation replays must not depend on current policy or provider availability.
3. Acquire the idempotency identity lock and examine a saved result. For challenge operations, check required binding and logical expiry under the challenge lock before applying replay rules. Terminal verification replay uses the non-code fingerprint only. A matching replay bypasses selector execution, current quotas, and new state changes.
4. For a new create, release the preliminary replay-check transaction and its locks, validate purpose-policy permission, run the selector outside any transaction, resolve templates, and validate the initial choice. In the commit transaction recheck idempotency and creation quotas before writing anything. For existing challenges, take quota and state locks in the documented order and sample fresh database time. Verify purpose/context before code comparison or guess accounting.
5. For a new verify, reject verified state with `409 challenge_state_conflict`; reject expired, cancelled, or locked state with `410 challenge_unavailable`. Then check aggregate guess limits and compare the code. For delivery actions check lifecycle, allowed choice, cooldown, and current budgets before queueing. Dispatch rechecks eligibility and reserves send budgets. Cancellation follows its documented terminal-state rules.

Allow up to 2,000 ms to acquire an operation's idempotency identity lock, then return `409 request_in_progress`. Other database lock or statement failures map to `503 temporarily_unavailable` when the transaction did not complete. An uncertain commit must be resolved by the same operation key; never report it as proof that no mutation occurred.

Wrong binding returns `404 challenge_not_found` without reporting the actual state. A syntactically invalid request may fail before binding. Exact transport rejection order does not promise whether oversized unauthenticated input receives 401 or 413, but neither path may read domain data or cause side effects.

Set `Cache-Control: no-store` on application responses. Use integer seconds rounded up for `Retry-After`. The `incorrect_code` envelope additionally includes `verificationState: "active" | "locked"` so the final consumed guess can report lockout. Other errors omit that field. Stable denied-action reasons are `challenge_unavailable`, `already_verified`, `cooldown_active`, `rate_limited`, `manual_selection_disabled`, `no_next_provider`, `provider_unavailable`, and `delivery_unavailable`. `select` exposes its eligible `choices` alongside `allowed`; deny it when no choices remain. Revalidate every choice when submitted.
