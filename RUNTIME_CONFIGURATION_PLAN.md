# Runtime provider and routing configuration

## Scope and release boundary

Manage provider accounts, sender instances, project assignments, and declarative routing policies through PostgreSQL and authenticated administration APIs without restarting API or worker processes.

**Breaking changes only. Remove superseded contracts and implementations; do not add compatibility shims, dual configuration sources, import paths, or backfills. Fold schema changes into the initial migration and require a new database. Explicitly reject previous database baselines.** Update affected component versions, clients, examples, and documentation together.

## Ownership model

| Resource | Contents |
| --- | --- |
| Provider account | Stable upstream identity, adapter reference, operational state, versioned credentials, shared allowance memberships. Independent of projects. |
| Provider instance | Routable configuration under an account: sender identifiers, templates, locales, timing, label, operational state, immutable configuration revisions. |
| Routing policy | Reusable, versioned policy with direct references to ordered instance IDs, purposes, capabilities, manual choices, fallback mode, and verification/send bounds. |
| Project assignment | Explicit account/instance and policy access, with independently revocable grant lifetimes. |
| Limit scope | Stable shared allowance identity and current limits, consumed by multiple accounts or instances. |

- One account or instance may serve multiple projects. Dedicated accounts and instances use the same model.
- Account grants restrict access to explicit instances unless all-instance access is deliberately granted.
- Policy access never implicitly grants provider access. Filter unauthorized steps while preserving order; reject creation if no route remains.
- Templates and locales belong to an instance revision, not separate instances for each language.
- Create accounts and instances disabled. Support atomic account creation with its first instance; enabling requires valid configuration.
- Retire resources and reserve their IDs; do not reuse identities.

## Deployment boundary

Keep adapter implementations, installed plugins, executable selectors, database connectivity, encryption keys, deployment identity, administrator/backend identities, permission ceilings, authorization integration, and hard safety ceilings in deployment configuration.

Replace the runtime catalog fingerprint with a deployment-capability contract covering adapter contracts, configuration schema support, and selector identities/versions. Runtime data edits must not change this contract. Replicas must support retained configurations and callbacks; incompatible code upgrades require a drain.

Adapters declare separate schemas for account identity, secrets, and non-secret execution configuration. Construct runtime providers from validated account credentials and immutable instance revisions. Policies may reference installed selectors; selectors only narrow/reorder authorized policy steps and never execute sends.

## Routing and operation snapshots

- Resolve policy, assignments, and instance revisions consistently at creation. Revalidate after selector execution before committing.
- Save policy identity/revision, route order, complete non-secret execution settings, resolved sender/template/locale, manual permissions, timing, and verification/send bounds.
- Ordinary policy and instance edits affect new operations only. Existing operations never silently adopt replacement settings or providers.
- Explicitly invalidate a revision when its saved configuration can no longer execute. Stop its uncommitted sends and permit eligible fallback.
- Fallback mode is disabled or advance after confirmed rejection/final failure. Known unavailable steps may be skipped.
- Uncertainty never permits automatic fallback, retransmission, or provider-call retry. Preserve this invariant for managed verification and external-code delivery.

## Credentials and callback authentication

- Rotation creates a credential version under the same account; preserve identity, quotas, assignments, and history. A different upstream account requires a new account identity.
- Select current send credentials at dispatch commitment and record their version ID. Committed attempts retain that version and may complete after rotation; recovery never repeats an invocation.
- Encrypt credentials and callback secrets with authenticated encryption. Bind ciphertext to deployment, account, purpose, and version; keep encryption keys outside PostgreSQL.
- Administration reads, responses, receipts, audit, errors, and logs expose no stored secrets. Return only allowlisted metadata such as version and presence. Use keyed fingerprints for secret-bearing idempotent requests.
- Separate send-credential and callback-verification lifecycles. Retain older callback verification versions while reconciliation needs them; allow explicit emergency revocation.
- Authenticate raw callbacks before normalization and enforce account/instance correlation. A shared signing secret alone does not establish attempt ownership.
- Disabled or retired send resources remain available for authenticated callbacks and reconciliation.

## Administration and consistency

- Extend `/v1/admin` for accounts, credential rotation, instances, policies, assignments, lifecycle, and audit. Keep domain operations in the engine and HTTP authentication/transport in the server.
- Separate permissions for shared-resource management, secret rotation, policy editing, and project assignment. Assignments require authority over both the project and the granted resource.
- Require idempotency keys and revision preconditions. Atomically commit mutations, redacted replay receipts, and allowlisted audit events. Check current permissions before replay; no-op/replayed requests add no audit event.
- Validate with Effect Schema and installed adapter schemas. Check references, template coverage, code constraints, lifetimes, capabilities, and access. Local validation does not prove remote credential validity or template approval.
- Dispatch reads authoritative lifecycle, assignments, credential version, and limits in the same transaction as quota reservation and dispatch commitment.
- Serialize disabling/revocation against dispatch using shared/exclusive locks and one documented lock order. After administration commits, later dispatch commitments cannot use invalidated authority; previously committed sends may complete.
- Cache immutable revisions and constructed adapters only as an optimization. Notifications may invalidate caches, but mutable authorization checks must reach PostgreSQL and fail closed.
- Account/instance revocation permits other authorized saved steps only when delivery evidence allows progression. Policy-assignment revocation stops every further uncommitted send under that policy.
- Re-enable/regrant creates fresh authority. Never revive queued sends or fallback chains; new explicit actions may use restored access within the original saved route.
- Preserve verification, closure, history, durable idempotency, authorization reconciliation, and late evidence handling.

## Quotas and retention

- Reserve recipient, project, account/instance, shared-scope, and deployment usage atomically. Count each invocation once per applicable scope, with sorted quota locks.
- Limit changes retain accumulated usage. Keep allowance memberships fixed initially; do not introduce scope reassignment that resets usage.
- Retain quota reservations for committed failed or uncertain sends independently of operation/history cleanup.
- Retain configuration revisions, callback keys, correlation, and deduplication while referenced work needs them, including reconciliation extensions caused by late evidence.
- Remove obsolete send secrets only when no committed execution needs them. Keep secret-free audit indefinitely.
- Extend stored-key validation, key-retirement checks, and encrypted-data maintenance to account secrets and secret-bearing receipt fingerprints.

## Implementation sequence

1. Define schemas, resource identities, revision/grant lifetimes, adapter contracts, and administration permissions. Replace the initial database schema and baseline marker.
2. Implement runtime resource administration, encryption, validation, idempotency, audit, and shared allowances.
3. Replace static provider construction and route preparation with database resolution and complete immutable snapshots.
4. Integrate authoritative dispatch gates, credential selection, revocation epochs/grant lifetimes, callback verification versions, and retention.
5. Replace catalog/readiness checks; update server/client contracts, provisioning examples, configuration guides, and fresh-database release instructions.
6. Verify dispatch-versus-disable/revocation races, regrant behavior, rotation and late callbacks, snapshot preservation, shared quota concurrency, secret redaction, and durable replay across both delivery capabilities. Run `pnpm check` and relevant tests.
