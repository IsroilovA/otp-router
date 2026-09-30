# Consistency and retention

## Atomicity

Preparation, admission usage, public events, and the replay result either commit together or leave no operation. Code attachment and initial delivery work are atomic. One-step creation rolls back entirely if attachment fails; managed creation also includes the verifier.

Verification, lockout, cancellation, and expiry close delivery and erase secrets atomically. Expected rejections after logical expiry must preserve that expiry; infrastructure failures, defects, and interruption must not leave partial transitions.

Before invoking a provider, durably establish eligibility, any required [send authorization](authorization.md), and quota reservation. Reconcile the outcome separately. A lost commit acknowledgement or abandoned dispatch never authorizes another invocation. Reservations survive failed or uncertain dispatched sends.

Public snapshots, immutable events, notification work, and mutation receipts must agree with the committed domain change. A crash must not leave committed work without durable scheduling or publish an uncommitted change.

Operations preserve their original binding, deadline, route, templates, and policy settings. Authorization decisions, dispatch commitments, and provider evidence remain distinct. Later configuration changes cannot rewrite historical snapshots or replay receipts.

Administrative mutations atomically commit project or runtime resources and grants, their original replay response, and one allowlisted audit event per actual change. Projects and grant lifetimes are authoritative database relationships; provider attempts reference immutable send intents and saved route steps. An intent and its backend grant must belong to the same project.

Account ownership, allowance memberships, policy steps, and credential account/purpose bindings are enforced by database relationships. Saved routes reference immutable policy and instance revisions. Administrative views and operation snapshots are derived from those records, rather than independently mutable copies.

## Time and concurrency

Runtime admission and dispatch take shared project locks; administration takes an exclusive project lock. Lock order is deployment-capability registration, runtime authority, project, request identity, sorted quota scopes, operation/challenge, then event stream. Runtime reads and dispatch take a shared transaction advisory lock; resource administration takes it exclusively before project locks. This serializes disabling, revocation, rotation, and limit edits against dispatch commitment. Network calls run outside these transactions and eligibility is revalidated afterward.

Database time governs deadlines, cooldowns, and rolling windows. Concurrent requests cannot spend the same remaining allowance or apply conflicting terminal transitions. Waiting for admission or dispatch consumes the original lifetime; it never extends expiry.

## Replay and retention

Project-scoped request identities remain stable across service-credential rotation and separate managed from external operations. A code can be attached only once, regardless of request key. Terminal transitions erase recoverable secrets and code fingerprints; retained replay returns its original redacted receipt. See [caller replay rules](api.md#idempotency).

External replay results retain seven days and while active. A retained project-scoped receipt remains replayable even after its operation history has been removed. Managed replay results retain at least twenty-four hours and while active or dispatched. [Attempt-history retention](history.md#retention-window) owns the configurable reconciliation guarantee. History cannot be removed while dispatch remains unresolved. Quota accounting has an independent lifetime: deleting operation or attempt history cannot release admission, guess, or send usage. Each usage event is counted once per applicable scope, including when several rolling windows cover that scope. Committed dispatch reservations remain counted even if later evidence establishes noninvocation. Quota records survive their complete rolling windows.

Events can outlive their subjects while notification delivery remains outstanding; [history and event retention](history.md#retention-window) owns those rules. Backups and provider-held records have independent retention. Restoring a backup requires the [recovery procedure](operations.md#database-restore).
