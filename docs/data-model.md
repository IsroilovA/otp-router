# Data and transactions

PostgreSQL owns immutable outbound events, notification delivery state, revisioned public snapshots, durable challenge state, encrypted secrets, delivery history, callback correlation, idempotent responses, and quota usage. Router tables and pg-boss tables have separate schemas. Migrations must never modify queue-owned tables.

The migration files define the database layout. Runtime schemas validate returned rows and saved policy snapshots. Keep field inventories and SQL constraints in those sources rather than duplicating them here.

## Time and locking

Database time governs expiry, cooldowns, and rolling quota windows. Sample `clock_timestamp()` after acquiring the locks required for a decision. Transaction-start time cannot decide eligibility after a lock wait. Serialize timestamps in UTC.

When multiple locks are needed, acquire the operation's idempotency advisory lock, quota identities in sorted order, then the challenge row. Never acquire a quota lock while holding a challenge lock. Read immutable identifiers before locking when necessary, then recheck mutable state under the lock.

Creation locks and counts creation quotas. User delivery requests serialize their routing change on the challenge. Their send-quota checks are forecasts; dispatch locks and reserves the actual send budgets. Status queries do not reserve quotas.

## Atomic boundaries

Creation commits the challenge, encrypted secrets, initial delivery, delivery/expiry jobs, public revision 1, immutable event, notification job, quota usage, and replay result together. User delivery actions commit the new routing revision, superseded pending work, new delivery, queue job, and replay result together.

Dispatch commits eligibility, send reservations, and the dispatching state before a provider call. No database transaction spans provider or selector network work. Preserve a committed reservation when an outcome or commit acknowledgement is uncertain.

Verification commits the comparison result, any consumed guess, terminal transition, secret erasure, and replay result together. Expected rejection after logical expiry must still commit expiry and erasure. Database failures, defects, and interruption must roll back incomplete mutations.

Transactional enqueue uses the application's current connection through pg-boss's per-call database adapter. Sharing a connection URL does not make separate pools share a transaction. The [historical SQL experiment](research/sql-pg-research.md) explains this integration.

## Callbacks and replay

Authenticate callbacks before storing normalized events. Persist caller-supplied correlation before dispatch; save provider-issued references when responses arrive. Keep unmatched events for bounded reconciliation because a callback can arrive before the send response.

Serialize correlation updates before challenge updates. Merge duplicate and out-of-order evidence under the challenge lock. Only the current delivery revision can advance routing; terminal challenges cannot reopen.

Operation identities remain stable across API-key and fingerprint-key rotation. Terminal transitions erase code fingerprints while retaining redacted replay results. A retained result may outlive challenge history. Cleanup must not remove it before its retention deadline or reset live quotas.

See [security](security.md#retention) for retention and [operations](operations.md#database-restore) for restore procedures.

## Public events and notifications

Challenge transactions collect changed challenge IDs. After all nested outcome/callback changes, they project one resulting snapshot per challenge under its row lock. A canonical comparison excludes `revision` and `serverTime`; unchanged public content produces no event. Mutation responses publish their final snapshot before saving the idempotent response. Any subsequent failure rolls back both. Reads return the saved snapshot with a fresh server time. Expiry jobs run at the fixed deadline; cleanup and request paths repair overdue transitions.

`challenge_events` stores exact immutable JSON body bytes and a unique `(challenge_id, revision)`. Its records deliberately outlive challenge deletion when notifications remain outstanding. `notifications` contains only mutable attempts, lease, status, and safe failure category. Each notification claim commits before HTTP, and each outcome commits separately. Successful responses are 2xx. A timeout or crash can cause duplicate delivery of the same event, which is safe through receiver deduplication. Notification retries never touch OTP dispatch.

Transactional pg-boss enqueue accompanies every event and retry. Startup and periodic recovery repair missing jobs and expired leases. Failed notifications remain for diagnosis/replay; delivered events retain seven days. See [webhook integration](webhooks.md).
