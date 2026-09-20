# Verification and abuse controls

Status: implementation contract.

## Accepted code lifecycle defaults

| Setting | Accepted default |
| --- | --- |
| Code format | Six decimal digits, including possible leading zeroes. |
| Challenge lifetime | Five minutes from challenge creation. |
| Incorrect submissions | At most five per challenge. The fifth incorrect submission locks that challenge. |
| User-requested send cooldown | Thirty seconds, starting at initial or user-requested queueing and extending after each dispatch under D057. |
| Fallback and resend | Reuse the challenge's existing code. |
| Expiry after another delivery | Keep the original deadline. |
| Failed-guess counter after another delivery | Keep the existing count. |

These are product defaults, not values mandated by a standard. The router owns the original deadline under D059. See [time handling](data-model.md#ownership-and-identifiers) and [cooldown rules](routing.md#cooldown-and-deadlines).

Code reuse prevents delayed messages from carrying different codes. After expiry, starting again requires a new rate-limited challenge.

Bind verification to the challenge, recipient, purpose, and action context. Success atomically consumes the challenge; replay cannot authorize another business action.

Independent challenges for separate login or action flows are accepted under D033, including flows for the same recipient. Starting a laptop login does not invalidate a phone login. Repeating a create request with its idempotency key returns the existing challenge. See the [idempotency contract](api.md#idempotency-rules) for replay and changed-payload handling.

Recipient-level limits still aggregate across those challenges, so parallel flows cannot multiply the permitted guess or send budget without bound. Independent applications use separate deployments under D013.

## Supported configuration bounds

D064 accepts these bounds. Reject invalid settings at service startup.

| Setting | Supported values |
| --- | --- |
| Code length | Six to eight decimal digits. |
| Challenge lifetime | Sixty to six hundred seconds. |
| Incorrect guesses per challenge | One to five. |
| User-send cooldown | Thirty to three hundred seconds, strictly less than the challenge lifetime. |
| Sends per challenge | One to ten. |
| Automatic provider-send retries | Unsupported in v1. Reject configuration that enables them. |
| Incorrect guesses per recipient | One to ten per rolling fifteen minutes. |

Recipient and deployment limits remain mandatory. Validate code formats and delivery settings against each configured provider. Provider constraints can narrow the supported values. These bounds do not guarantee enough time to try every provider in a route.

## Secret handling

Generate codes cryptographically and keep them as strings to preserve leading zeroes. Store an encrypted copy for resends and a separate keyed verifier bound to challenge context. A bare hash permits offline guessing of the small code space.

Use independent keys for encryption, verification, request fingerprints, and recipient lookup. Scope keyed inputs to their use and deployment. Apply the [retention rules](#secret-retention-rules), including deletion of terminal code fingerprints. Delivery exhaustion preserves the verifier; remove send material early only when no permitted send needs it.

Exclude codes, credentials, and unnecessary recipient data from logs, traces, metrics, queue payloads, and workflow outputs. Jobs reference delivery IDs.

## Cryptography and key rotation

Under D065, use AES-256-GCM for recoverable OTPs and phone numbers, with a fresh nonce for each encryption. Authenticate the deployment, challenge ID, and field identity with each value so ciphertext cannot be moved between records. Use HMAC-SHA-256 for OTP verification, request fingerprints, and recipient lookup. Use Node's maintained cryptographic implementation and independent, securely generated keys for each purpose.

Load keys from deployment secrets at startup. Store key IDs and required cryptographic metadata with records, never the keys. Missing required keys fail startup; do not generate replacements or silently discard records. Authenticated encryption and separate key storage follow [OWASP guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html).

D066 accepts overlapping versions for encryption, verification, and request-fingerprint keys. Each purpose has one writing key and retained older keys for existing records. Deploy the new key to all processes first, then switch writers, and remove the old key only after no retained record requires it. No background re-encryption service is required for v1.

Challenge keys remain available until their last affected challenge and bounded provider operation end and cleanup removes the protected values. Fingerprint keys remain for the full retention of their records, at least twenty-four hours. Check actual references before removing a key; elapsed time alone is insufficient.

### Stable recipient key

Keep one stable recipient-lookup key in v1. No scheduled rotation, dual-key lookup, or online identity migration is required. Replacement changes quota identities and must follow the [incident procedure](#recipient-key-incident-procedure).

## Abuse controls

Challenge-level guess limits are only one control. Limit new challenges, verification failures, and actual send attempts by application and recipient over longer windows. Creating a new challenge must not reset all protection. Consider client-IP limits only when the IP comes from a trusted source, with allowances for shared networks.

Use atomic PostgreSQL operations for counters and state transitions across processes. Check limits before scheduling paid sends. Initial sends, fallback, and all user-requested sends must count toward send limits.

Keep locking a challenge distinct from locking a user's account. The application owns account policy. Operator limits may also restrict provider instances, destination countries, and total outgoing volume. Numerical recipient limits are accepted under D020 and required deployment caps under D058. Exact monetary accounting is deferred.

### Accepted numerical defaults

| Control | Accepted default |
| --- | --- |
| Provider-send attempts per challenge | Six in total, including initial send, fallback, and user-requested sends. |
| New challenges per recipient | Five in a rolling fifteen-minute window. |
| Provider-send attempts per recipient | Ten in a rolling fifteen-minute window across all challenges and policies. |
| Incorrect guesses per recipient | Ten in a rolling fifteen-minute window across all challenges and policies. |
| Automatic provider-send retries | None under D069. |

All applicable limits must pass, including the challenge guess limit and user-send cooldown.

For example, two Telegram/WhatsApp/SMS sequences consume six sends despite reusing one code. Confirmed rejection and provider refunds do not restore the allowance.

Count an initial send, fallback, or user action when reserving its provider dispatch. A paid availability check also consumes the allowance. An unpaid local eligibility check and a provider skipped without a request do not. A provider's preflight and send sequence must declare its charge behavior so it cannot multiply paid requests outside the budget.

Under D101, validate international phone input with a maintained parsing library and normalize it to E.164 before recipient lookup, quota aggregation, or routing. Require `+` and a country code; do not infer a country for local input. Parsing validates format and numbering rules, not existence, message reachability, messaging-account membership, or ownership. Adapters may convert the normalized value to provider wire formats without changing the core quota identity. Use the normalized recipient as the aggregation scope within the single application deployment. Changing a purpose, policy, channel, IP address, or challenge ID must not reset recipient-wide counters. A correctly repeated idempotent request does not create a second logical reservation.

Persist a delivery record when queueing. Reserve quotas and mark that record dispatching atomically just before the provider call. The same persisted record prevents a recovered job from spending the reservation twice. If the process crashes around a send, preserve both the uncertainty and the reservation; do not retry merely because the response is missing.

Use rolling windows based on database time. Rejected requests do not extend the blocking window. Return a retry time derived from the applicable limits. Aggregate verification failures must use concurrency-safe reservations or equivalent locking so simultaneous requests cannot overshoot the limit.

Rate limiting must reject work when its persistent enforcement is unavailable. Do not fall back to an unlimited path or independent in-memory counters on each process.

### Resend and recovery policy

Follow [routing failure rules](routing.md#failure-handling). Never retry a provider send automatically, including inside SDKs or transports. Explicit resend creates a new delivery record subject to the original deadline and all limits.

Queue retries resume persisted state. They may dispatch work that never crossed the dispatch gate or reconcile uncertainty without another send. Never reset an unresolved dispatch for another invocation.

### Additional configurable controls

Under D058, require positive operator-configured deployment send caps for rolling fifteen-minute and twenty-four-hour windows. There is no universal volume default or unlimited production setting. The service validates these settings before accepting work. Provider-specific caps remain optional.

Every send reservation counts against both deployment windows and all applicable recipient, challenge, and provider limits in the same transaction. A rejection does not extend a window, and a failed or uncertain send does not refund its reservation. Retain quota events for the longest applicable window, including twenty-four hours for deployment usage. Return the latest required release time across blocking limits. If quota state is unavailable, reject dispatch.

The adopting backend also limits public challenge requests and abusive clients. A server API key does not prevent an attacker from abusing the application's public login endpoint. Recipient guess limits deliberately block even correct submissions while exhausted; rejected requests do not prolong that block. The router does not lock the application's user account.

Destination restrictions belong in the adopting backend or custom routing selector under D075; there is no separate built-in country-policy subsystem. The core does not hard-code Uzbekistan-only recipients. IP limits are optional and accept identity only from the trusted backend or explicitly trusted proxy configuration.

Do not claim exact monetary spending limits without an authoritative price and reservation model. Initial spend protection can use hard send-count caps; observed provider costs may be reported separately where available.

## Design guidance consulted

OWASP recommends cryptographically generated, securely stored, single-use codes with expiry, along with controls against excessive requests. Its cited guide concerns password recovery; it does not prescribe all of this router's behavior or our numerical defaults. See [OWASP's password recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

NIST's authenticator guidance is another reference for verification-secret handling and rate limiting. Using a few of its recommendations does not establish an assurance level for this router or all its channels. See [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html).

## Secret-retention rules

Under D040, remove recoverable OTP ciphertext, its verifier, and all related code fingerprints when verification, cancellation, lockout, or expiry ends a challenge. Remove the encrypted recipient when the challenge ends and no bounded in-flight provider operation still needs it. Delivery exhaustion alone does not end verification and therefore does not erase the verifier.

Retain redacted challenge and delivery history for seven days after terminal state. Retain idempotency results for at least twenty-four hours and for as long as associated work remains active. Quota events remain until every applicable accounting window has ended. Raw provider callback bodies are authenticated, normalized, and discarded by default.

These defaults are configurable only when dependent guarantees remain intact. Logical expiry is enforced during every operation even if physical cleanup has not yet run. Local deletion does not remove provider-held data, logs, or backups; [operations](operations.md#cleanup-backups-and-late-callbacks) owns those procedures.

## Cryptographic record encoding

Use versioned encodings and independent 32-byte randomly generated keys. AES-256-GCM records store encoding version, key ID, a fresh 12-byte random nonce, ciphertext, and a 16-byte authentication tag. Persist binary values as database bytes; use base64url only when a textual envelope is needed. Encode associated data as a fixed-order JSON array of version, purpose, deployment identity, challenge ID, and field name, using UTF-8. Reject unsupported versions, invalid lengths, authentication failures, and missing keys without returning partial plaintext.

Use HMAC-SHA-256 over fixed-order, purpose-separated UTF-8 JSON arrays for verifiers and fingerprints. The code verifier includes deployment, challenge, purpose, context, and the code string. Recipient lookup includes deployment and canonical E.164 phone. Request fingerprints include operation scope and the canonical validated input described in the API contract. For operation-key lookup use SHA-256 of the deployment/operation/target/key tuple, separate from the rotating request-fingerprint key, so rotating that key cannot create a second operation identity. Operation keys must contain no recipient or code data. Compare fixed-length digests in constant time. Include key IDs with keyed values and test known vectors, leading zeroes, changed context, nonce uniqueness, and tampered ciphertext.

## Recipient-key incident procedure

Stop all application traffic and workers that could create quota events under the old identity before replacing the stable recipient key. Record the stop time. Invalidate active challenges, suppress pending sends, and erase their OTP material; do not attempt to associate old recipient tokens with new ones by guessing phone numbers.

If a trusted surviving source can reconstruct complete usage, migrate quota identities and events atomically under an operator-controlled maintenance procedure and verify totals before restart. Otherwise wait a full longest configured quota window from the recorded stop time, at least twenty-four hours with the default deployment windows. Late provider outcomes keep their original counted reservations; do not turn them into new uncounted work.

Install the replacement key consistently across every role before restarting. Preserve redacted idempotency results for their normal retention and do not reuse old operation keys to recreate abandoned flows. Verify that no old process remains and that a test recipient receives one quota identity across all replicas. Record completion in operator-controlled diagnostics without keys, recipient tokens, or phone numbers. Routine restart and ordinary encryption-key rotation do not invoke this incident procedure.
