# Data and transactions

The [initial migration](../packages/engine/src/database/migrations/0001_initial.ts) defines tables, constraints and indexes. This guide describes the guarantees that changes must preserve; [architecture](architecture.md) defines feature ownership.

## Time and locking

Database time governs deadlines, cooldowns and rolling windows. Sample it after acquiring locks. Acquire the request's idempotency lock, quota identities in sorted order, delivery operation row, then its challenge row. Never acquire quota locks after an operation/challenge lock. Callback correlation locks precede operation locks.

## Atomic boundaries

Preparation commits an operation, encrypted recipient, expiry work, admission usage, public events and replay result together. Attachment commits the code and initial delivery work. One-step creation composes both; invalid attachment rolls back the entire creation. Managed creation additionally commits the challenge and bound verifier.

Verification, lockout, cancellation and expiry close delivery and erase secrets atomically. Expected domain rejections after logical expiry still commit that expiry; infrastructure failures, defects and interruption roll back incomplete transitions.

Dispatch commits eligibility, quota reservations and the dispatch record before provider I/O. Outcome reconciliation commits separately. No transaction spans provider or selector network work. A lost commit acknowledgement never authorizes another invocation. Startup and maintenance can reconcile abandoned dispatches independently of queue retries, without sending again.

Public snapshots, immutable event bytes, notification jobs and mutation receipts commit with their domain changes. Each changed subject publishes its resulting projection; managed projection composes delivery with verification. Transactional pg-boss enqueue uses the current SQL connection.

## Replay and retention

Challenge and external-delivery request identities are separate and stable across API-key rotation. Attachment fingerprints prevent distinct request keys from replacing a code. Terminal transitions erase recoverable secrets and code fingerprints. Retained replay returns its original redacted receipt; [API idempotency](api.md#idempotency) defines caller behavior.

External replay results retain seven days and while active. Managed replay results retain at least twenty-four hours and while active or dispatched. Terminal history retains seven days and cannot be deleted while dispatch remains unresolved. Quota records survive their complete rolling windows.

Events can outlive their subjects while notification delivery remains outstanding. See [webhook retention and replay](webhooks.md#delivery-and-recovery). Backups and provider-held data have independent retention; follow the [restore procedure](operations.md#database-restore).
