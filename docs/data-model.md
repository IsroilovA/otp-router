# Consistency and retention

## Atomicity

Preparation, admission usage, public events, and the replay result either commit together or leave no operation. Code attachment and initial delivery work are atomic. One-step creation rolls back entirely if attachment fails; managed creation also includes the verifier.

Verification, lockout, cancellation, and expiry close delivery and erase secrets atomically. Expected rejections after logical expiry must preserve that expiry; infrastructure failures, defects, and interruption must not leave partial transitions.

Before invoking a provider, durably establish eligibility and reserve quota. Reconcile the outcome separately. A lost commit acknowledgement or abandoned dispatch never authorizes another invocation. Reservations survive failed or uncertain dispatched sends.

Public snapshots, immutable events, notification work, and mutation receipts must agree with the committed domain change. A crash must not leave committed work without durable scheduling or publish an uncommitted change.

## Time and concurrency

Database time governs deadlines, cooldowns, and rolling windows. Concurrent requests cannot spend the same remaining allowance or apply conflicting terminal transitions. Waiting for admission or dispatch consumes the original lifetime; it never extends expiry.

## Replay and retention

Request identities remain stable across API-key rotation and separate managed from external operations. A code can be attached only once, regardless of request key. Terminal transitions erase recoverable secrets and code fingerprints; retained replay returns its original redacted receipt. See [caller replay rules](api.md#idempotency).

External replay results retain seven days and while active. Managed replay results retain at least twenty-four hours and while active or dispatched. Terminal history retains seven days and cannot be removed while dispatch remains unresolved. Quota records survive their complete rolling windows.

Events can outlive their subjects while notification delivery remains outstanding; [webhook retention](webhooks.md#delivery-and-recovery) owns those rules. Backups and provider-held records have independent retention. Restoring a backup requires the [recovery procedure](operations.md#database-restore).
