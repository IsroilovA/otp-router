# Decision register

Updated 2026-09-20. This is a historical index, not a second specification. Each entry links to its authoritative contract where useful. `Accepted` is settled, `Implementation` requires code or evidence under the owning contract, `Open` requires a product decision, and `Superseded` has been replaced.

## Product and platform

| ID | Status | Decision |
| --- | --- | --- |
| D001 | Accepted | Provide a self-hosted service that existing applications integrate with over HTTP under D070. |
| D002 | Accepted | Applications can add providers through a documented adapter contract without editing the core. |
| D003 | Accepted | Built-in and external providers use the same contract. |
| D004 | Accepted | Applications choose participating providers and their order; no channel is mandatory. |
| D005 | Accepted | Routing supports fallback between configured providers. [Routing](routing.md) owns the triggers. |
| D006 | Accepted | Built-ins are Telegram Gateway, direct Meta WhatsApp Cloud API, and Play Mobile SMS. |
| D007 | Accepted | Evaluate maintained packages before implementing common infrastructure. |
| D008 | Accepted | Planning produces Markdown specifications and implementation guidance. |
| D009 | Superseded | The original dual integration scope is replaced by the standalone service scope under D070. |
| D010 | Accepted | The router owns code generation, expiry, verification, limits, and delivery attempts. |
| D011 | Accepted | Use TypeScript on Node.js. Select the latest stable compatible runtime when implementation begins; exact builds belong in the lockfile and CI. |
| D012 | Accepted | Uzbekistan is the initial market, while the core remains general-purpose. |
| D013 | Accepted | One application per deployment in v1. |
| D014 | Accepted | PostgreSQL is the production database. |
| D015 | Accepted | Use Effect HttpApi and Schema, Vitest, and pnpm. D076 selects one router package without a workspace split. |
| D016 | Superseded | Duplicate of D006. |
| D029 | Accepted | Use the latest stable Effect release for the core, service, and provider contract; do not adopt prereleases by default. |
| D031 | Accepted | The public provider contract exposes Effect directly; no parallel Promise-based provider API is required. Core operation types remain internal. |
| D032 | Superseded | Play Mobile support is covered by D006. |
| D037 | Accepted | Ship one image with combined, API-only, and worker-only roles; PostgreSQL is the only required external service. |
| D038 | Accepted | V1 operator tooling is configuration, documentation, and diagnostic CLI commands; no administration dashboard. |
| D039 | Accepted | Use `@effect/sql-pg`, pg-boss, `PgMigrator`, and pg-boss migrations, preserving the tested transaction-local adapter rules. |
| D041 | Accepted | License the project under MIT with Alisher Isorilov as copyright holder. |

## Product behavior

| ID | Status | Decision |
| --- | --- | --- |
| D017 | Accepted | Advance after confirmed delivery failure; wait after uncertainty for an explicit user action under D068. |
| D018 | Accepted | Support resend and next-provider actions within cooldowns and limits. |
| D019 | Accepted | Defaults: six digits, five-minute lifetime, five incorrect guesses, thirty-second user-send cooldown, and code reuse without extending expiry. |
| D020 | Accepted | Defaults: six sends per challenge; per recipient, five creations, ten sends, and ten incorrect guesses per rolling fifteen minutes. Automatic send retries were removed under D069. |
| D033 | Accepted | Independent flows may have independent challenges; idempotent create retries reuse the original challenge. |
| D034 | Accepted | Load typed startup configuration with registered providers and named policies; keep credentials in deployment secrets. |
| D035 | Accepted | Policies may enable manual channel or provider selection; automatic fallback continues forward without wrapping. |
| D036 | Accepted | HTTP operations are backend-only and use a server API key; callbacks use provider authentication. |
| D040 | Accepted | Delete OTP secrets at terminal state, retain redacted history for seven days, and retain idempotency results for at least twenty-four hours without deleting active work. |
| D043 | Accepted | Ship English examples first while supporting configured locales and provider templates. |
| D044 | Accepted | Delivery exhaustion does not invalidate an otherwise active code. |
| D045 | Accepted | Trusted callers can cancel a challenge; cancellation blocks verification and pending sends but cannot recall an external request. |
| D046 | Accepted | V1 supports phone recipients only; email OTP, TOTP, passkeys, accounts, sessions, and general messaging are excluded. |
| D047 | Superseded | Previously accepted best-effort public lifecycle hooks. D074 defers them and retains structured logs and basic metrics. |
| D055 | Accepted | Definitive credential or balance rejection advances without retrying that delivery record and records an operator error. |
| D057 | Accepted | User cooldown starts at queueing and is extended by every dispatch; automatic sends do not wait for it. |
| D058 | Accepted | Production requires positive deployment send caps over rolling fifteen-minute and twenty-four-hour windows. |
| D059 | Accepted | One router-owned expiry governs verification; use fresh database time after locks and never extend it for delivery. |
| D060 | Superseded | Previously allowed one safe automatic send retry after definitive throttling or temporary rejection. D069 removes automatic provider-send retries. |
| D061 | Accepted | New delivery evidence suppresses pending automatic routing but not an explicit user action. |
| D062 | Superseded | Previously allowed opt-in timed fallback for uncertainty. D068 removes timed fallback. |
| D063 | Accepted | Explicit selection may revisit an eligible failed provider; automatic routing never wraps. |
| D064 | Accepted | Configuration bounds are defined in [security](security.md#supported-configuration-bounds). D069 removes the former automatic-retry setting. |
| D068 | Accepted | Automatic fallback requires confirmed rejection or final delivery failure. Uncertainty always waits for an explicit user action; timed fallback is unsupported. Resend through the current eligible provider remains available after uncertain or confirmed delivery within limits. Applications control exposure of permitted manual selection. [Routing](routing.md) owns these rules. |
| D069 | Accepted | No automatic provider-send retries in v1, even with provider idempotency. Definitive temporary rejection advances to the next eligible provider. User resend creates a new delivery record; job recovery may resume unsent work or reconcile uncertainty but cannot repeat a dispatched send. Reject settings enabling automatic send retries. |
| D070 | Accepted | Ship the standalone self-hosted HTTP service in v1, backed by one internal core shared by HTTP handlers and workers. Public embedded SDK support is deferred. Keep the core independent of HTTP and process startup so future embedded support can reuse it. Do not build public SDK APIs or embedding-specific lifecycle machinery in v1. |
| D071 | Accepted | Built-in providers use the standard image with startup configuration and runtime secrets. Install custom adapter packages at image build time and register them explicitly. Configuration may be supplied at startup; the deployment workflow belongs in [operations](operations.md#custom-provider-deployments). |
| D072 | Accepted | One global default locale and ordered explicit fallback list apply to adapter-specific templates. Resolve each provider separately at creation and persist the result; providers may use different languages. Reject missing coverage without silently changing the route. [Templates](plugins.md#templates-and-localization) owns resolution rules. |
| D073 | Accepted | Validate local configuration, secrets presence, references, template coverage, placeholders, and known adapter constraints at startup. Remote credentials, approval, account status, and delivery belong to optional live diagnostics or explicit tests, not startup requirements. |
| D074 | Accepted | Defer public lifecycle hooks. Provide redacted structured logs and basic metrics as diagnostics, not a durable business-event feed. Incoming authenticated provider callbacks remain supported. |
| D075 | Accepted | No built-in regional-rule engine, country-policy subsystem, automatic provider-health scoring, circuit breaker, or health-based routing. Keep custom routing functions, selector destination rejection, adapter destination constraints, operator disables, and service health checks. |
| D076 | Accepted | Produce one self-contained router package and one official container image; distribution visibility follows D104. Expose configuration, provider, and selector contracts; keep core modules private. External adapters may be separate packages. No internal workspace split is required. |
| D077 | Accepted | Use one delivery record for a requested send and its external outcome. Each record permits at most one send invocation. Resend and fallback create new records; quota reservation and crash recovery stay atomic. |
| D078 | Accepted | Default message examples contain the code without relative-lifetime claims. The application uses absolute `expiresAt` and `serverTime` for validity; action `availableAt` and HTTP `Retry-After` indicate request eligibility only. Optional message expiry must remain accurate and use an explicit timezone. |
| D079 | Accepted | Custom selectors choose an ordered subset of policy-permitted providers or reject creation; configuration owns all other settings. Save the route for later actions, constrain manual choices to it, bound execution, and fail creation on errors or timeout without substituting a default route. Selectors may read external information but cannot send messages or perform business actions; concurrent uncommitted creates may execute them more than once. |
| D080 | Accepted | Default selector timeout is 2,000 milliseconds, configurable at deployment startup. One deadline covers the entire execution and external reads. Timeout fails creation without sending; discard late results and allow caller retry with the same idempotency key. |
| D081 | Accepted | Require idempotency keys for create, verify, all delivery actions, and cancellation; status reads need none. Reuse a key for the same operation and use a new key for a new user action. Replay stored results without duplicate mutations or guesses, including incorrect-code results. Reject missing keys before state changes. Provider callbacks retain their separate deduplication contract. |
| D082 | Accepted | Creation and user delivery actions return after their state, delivery record, queue job, and idempotency result commit atomically. Workers contact providers afterward. Success means queued work, not provider acceptance or delivery; callers read status for subsequent outcomes. |
| D083 | Accepted | Successful verification returns plain JSON with router-generated `verificationId` and `challengeId`, stored backend-supplied `purpose` and `contextId`, and database `verifiedAt`. Check purpose and context before code comparison. Replays preserve the result. Issue no JWT or login token; the application consumes its bound action once. |
| D084 | Accepted | Retrieve later delivery updates through authenticated challenge-status queries. No outgoing application webhooks, WebSockets, or server-sent event stream in v1. Incoming provider callbacks remain supported. Polling is optional; verification returns success or an error directly in its HTTP response. |
| D085 | Accepted | Authenticate application HTTP requests with deployment-secret Bearer API keys loaded at startup. Normally use one key; allow old/new overlap with at most two equally privileged keys during rotation. No users, roles, per-key permissions, or key-management API/dashboard in v1. Rotation preserves challenges, quotas, and idempotency scope; provider callbacks use separate authentication. |
| D086 | Accepted | Reusing a scoped idempotency key with changed validated input returns `409 idempotency_conflict` without additional side effects. Matching completed requests replay the saved result; new actions use new keys. Preserve D056 terminal-verification replay: after deleting code fingerprints, compare the original operation key and non-code fields only, never creating another verification. |
| D087 | Accepted | Concurrent requests with the same scoped operation key cannot commit duplicates. A competing request waits for a bounded period and replays a completed matching result; otherwise return `409 request_in_progress` with guidance to retry the same key and input. Exact wait duration remains operational tuning. |
| D088 | Accepted | Save failure results that committed state changes, including consumed guesses, atomically with those changes. Do not save completed results for authentication or input failures, transient cooldown/rate rejections without state changes, or rolled-back transactions. Such failures do not pin a key to a temporary result. Successful operations remain replayable. |
| D089 | Accepted | After required retention and actual cleanup, reuse of an idempotency key is treated as a new operation under normal state and limit checks. Replay is not guaranteed forever. Clients generate fresh random keys for new actions and do not recycle old ones. Preserve the twenty-four-hour minimum and active-work retention under D040. |
| D090 | Accepted | Defer automatic provider status polling in v1. Use send responses and authenticated incoming callbacks for delivery evidence. Recovery and application status reads do not query providers. Missing evidence remains unconfirmed and does not trigger fallback. Application polling of our status endpoint remains supported. |
| D091 | Accepted | Revised: run router and queue migrations automatically during startup, using PgMigrator and pg-boss respectively. Coordinate concurrent migrations and become ready or process application jobs only after both succeed. Stop old processes before incompatible upgrades. A separate migration command/job is not required for v1; startup failure must not permit traffic or sends. |
| D092 | Accepted | Every adapter declares a valid default send timeout; operators may override it per provider instance. The core enforces the effective timeout across the whole send operation, bounded by remaining challenge lifetime. Reject missing or invalid defaults and overrides at startup. No universal send timeout; timeout without definitive evidence remains uncertain and cannot trigger automatic resend or fallback. |
| D093 | Accepted | On shutdown, stop new application requests and delivery-job claims, allow a bounded configurable grace period for in-flight work, persist outcomes where possible, and close resources. Preserve unresolved dispatched sends and reservations as uncertain without resending; undispatched work remains recoverable. Forced crashes rely on persisted recovery safeguards. |
| D094 | Accepted | Separate liveness from readiness. Liveness checks process responsiveness. Readiness requires valid configuration, database connectivity, compatible schemas, and initialized role resources; workers need a running processing loop and combined processes satisfy both roles. Startup and shutdown remain unready. Exclude messaging-provider availability and provider calls from health checks. |
| D095 | Accepted | Load one TypeScript configuration entry file from an operator-supplied path at startup. Allow ordinary TypeScript imports and external secrets. No parallel YAML/JSON formats, automatic multi-file merging, or live reload in v1. Apply changes through restart under the existing drain and rotation rules. |
| D096 | Accepted | Application routes are POST `/v1/challenges`, GET `/v1/challenges/{challengeId}`, and POST `/v1/challenges/{challengeId}/verify`, `/deliveries`, and `/cancel`. The deliveries endpoint accepts one tagged resend, next, or select action; selection targets a permitted channel or provider instance. Provider callbacks use separate routes and authentication. |
| D097 | Accepted | Use 201 for challenge creation, 202 for queued delivery actions, and 200 for status, successful verification, and cancellation. Accept the HTTP error statuses and stable domain error codes in [API design](api.md#accepted-http-status-mapping). Later provider failures appear in delivery status without changing the prior successful queueing response. |
| D098 | Accepted | Use one HTTP error envelope with stable `code`, safe developer-facing `message`, diagnostic `requestId`, and optional known `retryAt`. Cooldown/rate responses include `Retry-After` without guaranteeing future success. Exclude raw provider data, stack traces, codes, and credentials. |
| D099 | Accepted | Use strict TypeScript throughout, specific tagged expected errors in Effect, typed states, exhaustive error mapping, and runtime validation at external boundaries. Keep defects and interruption separate. Avoid unchecked typing escapes; isolate and validate unavoidable third-party bridges. One HTTP envelope does not imply one generic internal error type. |
| D100 | Accepted | Map unexpected programming defects to `500 internal_error` with a safe generic message and request ID; keep redacted details in logs. Expected temporary infrastructure failures remain `503 temporarily_unavailable`. Do not reinterpret defects as wrong codes or confirmed provider failures, or use them to authorize fallback. |
| D101 | Accepted | Accept international phone numbers with `+` and country code only. Use a maintained library to validate and normalize to E.164 before routing and recipient-limit accounting; never guess a country for local input. Adapters own provider-specific formatting. Validation does not establish existence, reachability, or ownership. |
| D102 | Accepted | Challenge creation requires recipient, purpose, contextId, and policyId; locale, deliveryChoice, and bounded routingContext are optional. Validate policy permission for the configured purpose. The router generates code, challenge ID, and expiry. |
| D103 | Accepted | V1 permits planned maintenance for incompatible upgrades; uninterrupted upgrades are not required. Allow rolling upgrades only after compatibility across schemas, jobs, plugins, and configuration is established. Release instructions describe the drain, stop, migration, and restart procedure without extending challenge expiry. |
| D104 | Accepted | Distribution remains private for now. Build the router package and container for local or access-controlled use; public registry publication requires a later explicit decision. Package names and registry accounts can wait until release. |

## Architecture and security

| ID | Status | Decision |
| --- | --- | --- |
| D042 | Accepted | Supported public extensions are provider adapters and custom creation-time routing functions with a persisted snapshot. D074 removes lifecycle hooks from v1. |
| D048 | Accepted | A database restore invalidates restored active challenges and pending sends before traffic resumes. |
| D049 | Accepted | Configuration is immutable per process; incompatible provider changes require draining, never silent account substitution. |
| D050 | Accepted | Store the verification ID and timestamp on the challenge; no separate result table. |
| D051 | Accepted | Test persistence and concurrency against real PostgreSQL; use fake providers, not a fake storage implementation. |
| D052 | Accepted | pg-boss owns scheduling and leases; router records own eligibility, routing, reservations, and outcomes. |
| D053 | Accepted | Sending is required; add callbacks where supported and other provider capabilities only for verified use cases. |
| D054 | Accepted | Settle product and security invariants before implementation; concrete signatures, DDL, and tuning may follow during implementation. |
| D056 | Accepted | Delete code-dependent idempotency fingerprints at terminal state while preserving redacted replay results. |
| D065 | Accepted | Use independent AES-256-GCM and HMAC-SHA-256 keys by purpose and bind encrypted values to their record and field. |
| D066 | Accepted | Rotate encryption, verification, and fingerprint keys with overlapping versions; no background re-encryption in v1. |
| D067 | Accepted | Keep one stable recipient-lookup key; replacement is an incident procedure, not routine rotation. |

## Implementation and evidence work

| ID | Status | Remaining deliverable |
| --- | --- | --- |
| D021 | Implementation | Implement the [extension contract v1](plugins.md#extension-contract-v1), exported types, and separately compiled custom adapter fixture. |
| D022 | Implementation | Implement the [versioned snapshot and queue schemas](data-model.md#persisted-snapshot-and-queue-versions) and schema-derived selector types. |
| D023 | Implementation | Implement and test the [API boundary and validation order](api.md#boundary-validation-and-ordering), bounds, authentication, and generated OpenAPI. Remaining wire details are specified. |
| D024 | Implementation | Obtain [provider-specific callback evidence](provider-research.md#remaining-provider-evidence) and run crash/recovery tests. Automatic polling remains deferred. |
| D025 | Implementation | Implement [diagnostic fields and access](operations.md#diagnostic-fields-and-access), cryptographic encodings, and the [recipient-key incident procedure](security.md#recipient-key-incident-procedure). |
| D026 | Implementation | Implement adapter template schemas and obtain the [remaining provider evidence](provider-research.md#remaining-provider-evidence). Do not claim unverified remote behavior. |
| D027 | Implementation | Build private artifacts and record tested dependency/runtime/database ranges and compatibility under the [operational contract](operations.md#initial-runtime-limits-and-compatibility). |
| D028 | Implementation | Meet the [private release acceptance gates](release-checklist.md). Gates are specified; application test evidence does not exist yet. |
| D030 | Implementation | Run and document the [benchmark procedure](release-checklist.md#benchmark-procedure). Operators own production sizing; no adopter traffic estimate is needed. |

When a decision changes, update its owning contract and this index together. Preserve superseded entries only when they explain history.
