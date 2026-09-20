# Data model and transaction boundaries

Status: implementation contract; migrations pending.

## Ownership and identifiers

Use an `otp_router` schema for router tables and a separate `pgboss` schema for queue-owned tables. A deployment owns both. Independent deployments must use separate schema pairs or databases; sharing tables without a namespace would merge their challenges and abuse limits. Namespace configuration is deployment configuration, not a caller-controlled tenant field.

Generate random opaque UUIDs for challenges, delivery records, and verification results. Keep public IDs independent from provider correlation IDs, since provider formats may impose shorter limits. Database timestamps use `timestamptz` and database time governs expiry and quota windows.

Under D059, store instants as `timestamptz`, set database sessions to UTC, and serialize API timestamps with `Z`. Store durations as integer milliseconds or seconds with units in field names. After required locks are acquired, sample `clock_timestamp()` for expiry, cooldown, and quota decisions. `now()` and `CURRENT_TIMESTAMP` remain fixed at transaction start and must not decide eligibility after a lock wait. Use one fresh sample for each atomic decision. A challenge is eligible only while that sample is strictly before `expiresAt`.

Set `createdAt` from the database after creation locks and derive `expiresAt` once. Queue delay consumes the lifetime. Process clocks and provider timestamps cannot extend it. Reads use a fresh database sample to report logical expiry. See PostgreSQL's [timestamp types](https://www.postgresql.org/docs/current/datatype-datetime.html) and [current-time functions](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).

Use typed columns for frequently queried lifecycle fields. Store the versioned policy snapshot as validated JSONB. Do not serialize Effect values, functions, provider secrets, arbitrary request bodies, or runtime objects.

## Router tables

| Table | Required data | Constraints and lookup paths |
| --- | --- | --- |
| `challenges` | ID; purpose; opaque context ID; recipient lookup token and key version; policy ID and snapshot version; snapshot with per-provider resolved locale and template settings; requested or default locale; verification state; verification ID and verified timestamp; creation, expiry, and terminal timestamps; incorrect-guess count; send count; routing revision; automatic-routing stop flag; current delivery record ID; next permitted user-send time. | Primary key on ID; unique non-null verification ID; index on active expiry and terminal cleanup time; nonnegative counters. Verification fields exist only for `verified` challenges. One terminal state is permanent. |
| `challenge_secrets` | Challenge ID; encrypted phone number; encrypted OTP; encryption metadata; keyed code verifier and verifier key version. | One row per challenge; no plaintext code or recipient columns. Remove OTP ciphertext and verifier on terminal transition. Retain phone ciphertext only for a documented bounded in-flight need. |
| `deliveries` | ID; challenge ID; provider instance and fingerprint of non-secret delivery settings; route position and revision; reason; due time; state; provider idempotency key where supported; reservation, dispatch, and completion timestamps; acceptance certainty; normalized error code; provider correlation reference. | Primary key on ID. Unique logical advancement key prevents duplicate fallback. At most one send invocation per record. Index due work and challenge history. Initial delivery, fallback, resend, and selection create new records; dispatch reserves quota once. Recovery cannot create another invocation for a dispatched record. |
| `provider_correlations` | Provider instance with stable account identity; provider request ID or caller-supplied reference; related delivery ID. | Unique provider reference within its declared account scope. Persist caller-supplied references before sending. Repeated idempotent responses can map to the same delivery record. |
| `callback_inbox` | Provider instance; deduplication key; received and provider-event timestamps; normalized status; correlation reference; processing state. | Unique instance and deduplication key. Store authenticated, redacted normalized fields only. Index unmatched correlation references and cleanup time. |
| `idempotency_records` | Operation scope; key digest; keyed fingerprint of non-code fields; optional active-challenge code fingerprint; fingerprint key versions; redacted response and HTTP status; related challenge; creation time and retain-until time. | Unique operation scope and key digest. Result insertion and domain mutation share a transaction. Terminal transitions erase all related code fingerprints while preserving replay results. |
| `quota_keys` | Stable quota identity, such as recipient or provider scope. | Primary key supplies a row to lock even before the first usage event exists. Key rotation must preserve recipient aggregation. |
| `quota_events` | Unique reservation or failure-event ID; quota identity; event kind; counted amount; database timestamp; minimal redacted correlation IDs. | Unique reservation per quota prevents recounting queue redelivery. Index quota identity, kind, and time. Retain until every applicable window has ended. |

Do not store arbitrary provider responses. Queue payloads contain versioned internal identifiers.

Store verification on the challenge row and each requested send in one `deliveries` row. No separate result, intent, or attempt tables are needed. Router records enforce eligibility and accounting; pg-boss owns scheduling, claims, leases, and recovery.

An incorrect guess creates quota usage only after a valid active request reaches code comparison and fails. A rejection due to an existing limit, invalid binding, or expired challenge creates no additional wrong-guess event. A replay of the same failed verification creates no additional event.

## Transaction order

For operations that require several locks, use this order: idempotency identity, quota keys in a deterministic sorted order, challenge row, then delivery rows. Read immutable identifiers before acquiring locks when needed, then recheck lifecycle state under lock. No operation may hold a challenge lock while waiting for a quota lock. The idempotency identity lock does not lock the stored result row.

Callbacks and cleanup need only their relevant state locks. They must not synchronously perform paid sends. Enqueueing work can happen in their transaction; actual quota reservation belongs to the worker dispatch transaction.

Use the researched transaction-local pg-boss adapter for atomic enqueueing. All mutations within a domain operation use the same PostgreSQL transaction. Bound statement and lock waits. Provider HTTP and routing-selector network calls run outside database transactions.

| Operation | Atomic changes |
| --- | --- |
| Create | Recheck idempotency and creation quotas; insert challenge and secrets, count creation, insert initial delivery record, enqueue work, and store the response. |
| User delivery action | Recheck idempotency, lifecycle, policy, and cooldown; advance routing revision, reset the automatic-routing stop flag, supersede conflicting pending work, set cooldown, create the delivery record, enqueue work, and store the response. Dispatch reserves sends later. |
| Worker dispatch gate | Lock applicable quotas and the challenge; recheck revision, routing stop flag for automatic sends, deadline, provider state, and all limits; reserve a counted invocation, extend cooldown, and mark dispatching. Commit before contacting the provider. |
| Provider result | Record normalized outcome; update correlation; apply at most one applicable fallback transition after confirmed rejection or final delivery failure; enqueue any resulting work. Do not reopen a terminal challenge. |
| Incorrect verification | Check recipient and challenge limits under lock; compare the code; increment the guess count and aggregate usage, lock the challenge if necessary, erase terminal secrets, and save the idempotent failure result. |
| Correct verification | Check limits and binding; set verification ID and timestamp on the challenge; mark verified, invalidate pending routing, erase code secrets and all related code fingerprints, and save the redacted idempotent result. |
| Cancellation | Check existing state; mark cancelled, invalidate pending routing, erase code secrets, and save the idempotent result. |
| Expiry cleanup | Mark an overdue active challenge expired, invalidate pending routing, and remove code secrets. Requests enforce expiry even before this transaction runs. |

Routing selectors execute before the create transaction and may run more than once for competing uncommitted requests. Require them to be free of paid or business-action side effects. Resolve per-provider locale and template settings before committing; the idempotent transaction commits only one selected snapshot. A completed replay bypasses selector execution.

Every terminal transition clears code fingerprints from all verification idempotency records for that challenge. Use a transaction-scoped advisory lock for the idempotency identity. Read an existing result without a row lock; lock or update its row only after acquiring the challenge lock. This lets terminal cleanup erase fingerprints without deadlocking against replay. Completed verification replays use the challenge lock but need no quota locks because they consume no new guess.

If history cleanup has already removed the challenge, a retained verification result may replay only when its code fingerprint is already cleared. Match its non-code fields and return the stored result. History cleanup must not cascade-delete idempotency records before their retention deadline.

## Callback arrival before send completion

A provider can report status before the worker stores the send response. Authenticate and validate the callback first. Persist only its normalized event, then match it through `provider_correlations`. If correlation is not yet known, retain the event for bounded reconciliation instead of discarding it or guessing a challenge from the phone number.

Persist a provider-issued reference when the send response arrives, then process matching inbox events. A redelivered callback must not cause duplicate fallback. A provider that supplies neither a caller correlation field nor a recoverable server reference may leave a crashed send uncertain; this design does not promise otherwise.

Expired or removed correlation history must not resurrect challenges. Authenticated orphan callbacks follow the provider's acknowledgement contract and retention limits. Do not store unauthenticated callback payloads in the trusted inbox.

## Retention and redaction

Apply [security retention rules](security.md#secret-retention-rules). Quota events survive challenge deletion for their full accounting windows. Delivery exhaustion preserves the verifier; remove recoverable code material only when no permitted send needs it.

Context IDs, recipient lookup tokens, and provider references remain pseudonymous after redaction. Keep them out of unrestricted logs and public metrics.

## Required database checks

Test simultaneous correct submissions, incorrect guesses at both quota boundaries, duplicate creates, duplicate delivery actions, and verification racing cancellation or dispatch. Include replay racing terminal fingerprint deletion. Assert final rows, counters, queued work, and response replays, not just return values.

Test callback arrival before send response, duplicate callbacks, stale routing revisions, and process death around every dispatch boundary. Exercise retention while callbacks, queue jobs, and idempotency replays remain active. Verify that deleting challenge history cannot reset a live recipient limit.

Migration DDL and measured worker tuning remain implementation work. See the [release checklist](release-checklist.md) for required evidence.

## Persisted snapshot and queue versions

Snapshot version `1` contains `policyId`, `codeLength`, `lifetimeSeconds`, `maxIncorrectGuesses`, `maxSends`, `resendCooldownSeconds`, `manualSelectionEnabled`, `requestedLocale`, and the ordered `providers` array. Each provider entry contains `providerInstanceId`, `pluginId`, `contractVersion`, `channel`, `resolvedLocale`, validated non-secret `template` when required, `sendTimeoutMs`, delivery constraints, and a fingerprint of its non-secret account and sender identity. Use explicit optional fields, not arbitrary provider-response blobs. Schema validation must reject incompatible versions before work can dispatch.

The snapshot freezes challenge-specific settings. Live deployment quotas, configured purpose restrictions for new creation, and emergency provider disables remain deployment controls. A snapshot cannot grant permission to ignore those controls. Credentials and arbitrary routing context are excluded. Persist the snapshot atomically with the challenge and its first delivery.

Delivery jobs carry `{ version: 1, deliveryId, routingRevision }`; look up the authoritative challenge through the delivery row. Cleanup jobs use a distinct versioned payload and bounded batches. Reject unsupported job versions without a provider call and emit a redacted diagnostic. Release metadata declares which snapshot, job, and schema versions the build can read and write.

Enforce primary keys, references, state checks, and nonnegative counters in SQL. Enforce a unique automatic-advancement identity over challenge, routing revision, and destination route position for fallback records. Explicit user actions get new revisions. Keep callback correlation uniqueness scoped to the provider account. Insert quota identities before locking them in sorted order, and do not delete quota lock rows while another transaction can use them. Use partial indexes for active expiry and pending work; choose additional indexes from measured queries rather than adding a second scheduler.
