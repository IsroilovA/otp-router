# Runtime providers and routing

Provider accounts, instances, policies, assignments, and shared allowances live in PostgreSQL. Use the authenticated administration client or API to provision and change them without restarting API or worker processes. The [runtime schemas](../packages/engine/src/runtime/contracts.ts) and generated [API reference](api.md) own the command and response shapes. The [provisioning example](../examples/admin/run.ts) creates a working fake route without sending messages.

## Ownership and access

An account identifies one upstream account and installed adapter. Its identity and allowance memberships are immutable. Create a new account for a different upstream identity; rotating credentials preserves the existing account, history, quotas, and assignments. An instance holds its sender, templates, locales, timing, and label. Multiple projects can share the same account and instances.

Accounts and instances start disabled. Atomic creation can include an account's first instance; credentials are added through separately authorized rotation commands. Enabling requires locally valid configuration. Local validation does not establish remote credential validity or template approval. Retirement is irreversible and reserves the resource ID permanently.

Projects need separate policy and provider assignments. An instance assignment permits only that instance. An account assignment requires `allInstances: true` and deliberately permits every instance under that account, including future instances. Prefer explicit instance assignments. Policy access alone grants no provider access: creation filters unauthorized steps without changing their relative order and rejects an empty route.

Deployment permissions separately authorize shared-resource management, secret rotation, policy editing, assignments, reads, and audit. Assignments require authority over both the project and resource. Creation prefixes and resource prefixes are literal. Deployment configuration remains the only source of administrator identities and permission ceilings.

## Snapshots and authority

Creation resolves the policy, grants, and immutable instance revisions consistently. An installed selector can narrow or reorder that authorized route outside the transaction; creation revalidates its inputs before committing. The saved route includes policy identity and revision, capabilities and bounds, execution settings, resolved template/locale, manual permissions, and timing. Ordinary edits affect new operations. Existing operations keep their original route, code, deadline, and settings.

Invalidate a configuration revision explicitly when its saved settings can no longer execute. Uncommitted attempts cannot use it; confirmed noninvocation can permit eligible fallback. Policies choose disabled fallback or progression after confirmed rejection/final failure. Uncertainty never permits automatic retransmission, fallback, or provider-call retry. [Routing](routing.md) owns evidence handling for both managed and external capabilities.

Dispatch reads current lifecycle, assignments, revision validity, send credentials, and limits from PostgreSQL in the quota-reservation transaction. Administrative commit is the ordering boundary: later commitments cannot use disabled or revoked authority. Previously committed sends may finish. Disabling an account or instance can leave other authorized saved steps eligible when delivery evidence permits progression. Revoking a policy assignment stops all further uncommitted sends for its old intent.

Every assignment has an independent lifetime. Regranting or re-enabling creates fresh authority; it cannot revive queued sends or an old fallback chain. A new explicit action can use restored access within the operation's original saved route. Verification, closure, callbacks, durable replay, and history remain available under their own authorization rules.

## Secrets, replay, and retention

Send credentials and callback verification secrets have separate versions and lifecycles. Dispatch selects and records its send-credential version at commitment. Rotation cannot change a committed invocation, and recovery never repeats it. Authenticated callbacks retain the matching sender configuration revisions through early inbox storage and attempt reconciliation; a different saved sender cannot establish delivery evidence. Older callback versions remain usable for retained reconciliation, including after disabling or retiring send resources. Emergency callback revocation immediately excludes the revoked version from subsequent authentication.

Credentials are authenticated-encrypted with deployment, account, purpose, and version binding. Encryption keys remain outside PostgreSQL. Responses, replay receipts, audit, and errors expose only allowlisted metadata, never stored secrets. Secret-bearing commands use keyed request fingerprints. Retain encryption and fingerprint key IDs while stored versions or receipts reference them; startup rejects missing keys.

Every mutation requires an idempotency key; changes to existing resources require the original expected administration revision. The API returns an ETag for that revision. A configuration revision is separate: lifecycle changes, assignments, and credential rotations do not replace execution settings. Retry the exact original command and key after an uncertain response. Current permissions are checked before replay. Changes, redacted receipts, and allowlisted audit commit atomically; replays and no-ops add no audit event.

Shared allowance memberships are fixed at creation. An invocation counts once per recipient, project, account, instance, distinct shared scope, and deployment; overlapping membership never double-counts it. Limit edits retain accumulated usage. Failed and uncertain committed sends retain reservations independently of operation cleanup.

Configuration revisions and secret-free audit are retained. Callback keys and correlation remain while retained operations or callback reconciliation need them. Obsolete send ciphertext, including a retired account’s last version, is erased once no unresolved commitment needs it. Runtime administration receipts are retained indefinitely, so their fingerprint keys must remain available. Operation, event, and quota retention follow [consistency guarantees](data-model.md).
