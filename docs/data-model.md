# Data and transactions

The initial migration defines the schema directly; the engine is private and unreleased. Use fresh development databases, without upgrade shims or backfills. Router migrations never modify pg-boss tables.

## Records and ownership

`delivery_operations` owns recipient identity, purpose/context, a saved delivery policy and route, absolute expiry, prepared/active/closed/expired lifecycle, routing revision, send count, cooldown and public delivery projection. `delivery_secrets` binds encrypted recipient/code and an attachment fingerprint to an operation. Preparation has no code. `delivery_attempts` records individual provider invocations and their evidence; correlations point to attempts.

`challenges` owns a unique operation link, generation/guess settings, verification state, purpose/context binding and public challenge projection. `challenge_secrets` contains only the keyed verifier. Delivery code never queries challenge records. Composition supplies the owner projection and cross-capability maintenance.

The `events` table stores exact immutable bytes with a unique `(kind, subject_id, revision)` for `challenge.updated` or `delivery.updated`. Notifications reference those events and contain only mutable attempts, leases and safe outcomes. Events can outlive their originating records while notification delivery/replay remains outstanding.

## Time and locking

Database time governs deadlines, cooldowns and rolling windows. Sample `clock_timestamp()` after acquiring locks. Acquire the request's idempotency lock, quota identities in sorted order, delivery operation row, then its challenge row. Never acquire quota locks after a delivery/challenge lock. Callback correlation locks precede operation locks.

Preparation consumes shared recipient creation and admission quotas but does not reserve future provider capacity. User actions revalidate forecasts under locks. Dispatch locks and reserves actual recipient/provider/deployment send budgets. Automatic confirmed-failure fallback does not wait for user cooldown.

## Atomic boundaries

Preparation commits its operation, encrypted recipient, expiry job, snapshot/event, admission usage and replay result. Attachment commits encrypted code/fingerprint, active state, initial attempt, queue work and publication. One-step external creation and managed creation compose those primitives in a single transaction. Invalid one-step attachment rolls back creation.

Managed creation additionally commits its verifier and challenge. Verification, lockout, cancellation and expiry close delivery and erase secrets in the same transaction. The owner projection publishes resulting managed changes before commit. Domain rejections after logical expiry still commit expiry/erasure; infrastructure failure, defects and interruption roll back incomplete work.

Dispatch commits reservations before network I/O and stores outcomes separately. No transaction spans provider or selector network calls. A lost commit acknowledgement never authorizes another invocation. Transactional pg-boss enqueue uses the current Effect SQL connection through the per-call adapter.

## Replay and retention

Challenge request identities and external delivery request identities are separate, stable across API-key rotation. Their stored results are typed and redacted. Attachment fingerprints prevent distinct request keys from replacing a code. Terminal transitions erase recoverable secrets and code fingerprints, including request-code fingerprints. Retained replay then returns its original receipt without comparing erased code data or performing sends; status supplies current state.

External replay results retain seven days and while work is active; managed replay results retain at least twenty-four hours and while work is active or dispatched. Terminal history retains seven days and cannot be deleted while dispatch remains unresolved. A retried external creation always carries its original absolute deadline, so an expired request cannot recreate work after retention.

Quota records survive their complete rolling windows. Cleanup uses bounded transactions and drains full batches. Prepared operations expire through the same worker/request/cleanup paths as active operations. Restore invalidation closes both capabilities and erases all secret material.

## Publication and callbacks

Changed operation/challenge sets collect mutations within a transaction. Projection excludes revision/server time from comparison, producing one resulting revision per changed public state. Mutation responses publish before their replay result is stored. Reads return the saved projection with fresh server time; forecasts never reserve capacity.

Callbacks authenticate before normalized persistence. Duplicate and late evidence cannot advance stale routing revisions or reopen terminals. One notification claim commits before HTTP; outcomes commit separately. Notification retries may duplicate an event and never touch OTP dispatch. See [webhooks](webhooks.md) for receiver ordering and authentication.
