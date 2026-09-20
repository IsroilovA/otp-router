# Deployment and operations

Status: implemented and locally measured. See [benchmark results](benchmark.md) and [remaining release evidence](implementation-evidence.md).

## Accepted deployment model

Provide one image with combined API/worker, API-only, and worker-only roles. Combined is the default. Use compatible configuration and plugins across roles. PostgreSQL is the only required external service and holds shared state and scheduled work.

The router deployment owns workers and database pools. Applications integrate over HTTP. Process-local locks, timers, or caches cannot enforce cross-process correctness.

## Graceful shutdown

Mark the process unready, stop accepting new application requests and claiming jobs, then allow in-flight work to finish and persist outcomes. The configurable grace period defaults to 30,000 ms. On expiry, interrupt cooperative work and close owned resources.

Undispatched work remains recoverable. Unresolved dispatched sends retain their reservation and uncertainty, even after forced termination. Never resend them automatically or assume transport cancellation stopped remote processing. Late callbacks follow normal authentication and correlation rules. Shutdown neither cancels challenges nor extends expiry.

## Custom-provider deployments

The standard image includes built-in adapters. Operators configure them with the [entry file](#configuration-entry-file) and runtime secrets; no custom build is needed.

For custom adapters, create a deployment project with pinned router and adapter dependencies, explicitly import/register them, and build an image containing those packages. Provide a deployment template and example adapter using the [public contracts](plugins.md). No source fork or dynamic package installation is required.

Include configuration in the image or supply it at startup. Imports must already be installed. Supply provider credentials, API keys, and cryptographic keys through runtime secrets, never image layers or committed files. The runtime TypeScript loader and standard Dockerfile are implemented; custom deployment projects still own their image build and package artifact staging.

Use the same tested image across roles. Adapter code or dependency changes require a rebuild; externally supplied configuration and secret changes require restart under the procedures below. HTTP callers cannot install code, add credentials, or override provider endpoints.

## Configuration entry file

Load one TypeScript entry file from an operator-supplied path at startup. It defines providers, policies, selectors, templates, locales, limits, and timeouts. Ordinary imports may organize it. V1 has no YAML/JSON alternative, automatic multi-file merging, or live reload.

Read secrets from environment variables or secret stores. Configuration changes take effect through restart or replacement using the drain and rotation procedures below.

## Configuration changes

Under D049, every process loads immutable startup configuration. A challenge snapshots its route and non-secret delivery settings. Provider instance IDs must retain their account identity. Use a new ID when changing accounts, and do not reuse an old ID while its callback history remains. A missing or incompatible instance blocks its affected work; it must not resolve to a replacement account.

For an incompatible change, stop new challenge creation and let existing challenges finish or expire under the old configuration. Keep verification, callbacks, and existing worker jobs running during the drain. Stop old workers before starting the replacement configuration. A code-only rolling deployment is allowed only when schemas, queued jobs, plugins, and delivery settings remain compatible.

Emergency changes may stop all workers immediately and restart with the affected instance disabled. Every dispatch checks that startup disable. Verification remains available. Keep old callback verification credentials for the supported overlap where safe, or reject reports that can no longer be authenticated. Never preserve a compromised credential merely to finish a drain. V1 has no live configuration-history service.

## Upgrade availability

Incompatible upgrades may use planned downtime. Release instructions must identify schema, job, configuration, and plugin incompatibilities and give the drain, stop, startup-migration, and restart sequence. Measure migration duration on a stated environment and data size before promising a maintenance window.

Allow rolling upgrades only after compatibility across running versions and persisted data is established. Otherwise stop old processes first. Maintenance never extends challenge expiry.

## Application API-key rotation

Load one API key normally. To rotate:

1. Deploy both old and new keys to every API process with identical permissions.
2. Switch the application backend only after every API process accepts the new key.
3. Remove the old key and restart or replace the API processes.

Keep overlap limited to the transition. Rotation preserves challenge bindings, quotas, and idempotency scope. Test replay across rotation and rejection of the removed key. Cryptographic keys and provider callback credentials have separate rotation rules.

## Database restore

Under D048, keep application traffic and workers stopped during restore. Before restart, cancel every restored active challenge, erase OTP secrets and code fingerprints, and suppress its queued delivery work. Late callbacks can update history but cannot resume delivery.

A backup may omit recent sends, guesses, and completed operation keys. Restoring it does not restore exactly-once business behavior. The adopting application must abandon affected active flows and keep its own business-action consumption rules. Do not replay old queue work to compensate for missing history.

Before enabling sends or verification, establish conservative quota usage from a trusted surviving source, or wait a full longest configured quota window from the time all old instances stopped. With D058, that window is at least twenty-four hours. Document this recovery delay instead of silently granting fresh budgets. Ordinary process restart with an intact database does not require this procedure.

## Data ownership

Use separate [router and queue schemas](data-model.md#ownership-and-identifiers) in the deployment's database. Do not modify the adopting application's tables.

Every process role runs PgMigrator for router tables, then lets the installed pg-boss version initialize or upgrade its schema. Keep readiness false and do not accept application requests, register router job consumers, or schedule cleanup until both succeed. Fail startup with a redacted actionable error on migration failure or an unsupported schema; never attempt a downgrade. V1 requires no separate migration job.

Coordinate concurrent router migrations through the database and use pg-boss's own coordination for its schema. Both systems follow the same order but need not share a transaction. Restart must safely resume partial completion. Migration locks do not make old and new application versions compatible.

Application SQL and queue management use separate bounded pools with a combined connection budget. Enqueueing joins the application transaction through the [per-call adapter](data-model.md#transaction-order); no separate outbox relay is needed.

## Accepted operator interface

Provide configuration, setup guides, and diagnostic CLI commands for local validation and version/schema compatibility. The current CLI includes `--check-config`, `--check-schema`, `--openapi`, `--invalidate-restored`, and the incident-only `--adopt-recipient-key` procedure. Optional live diagnostics check credentials, sender/account status, templates, and connectivity. Distinguish read-only checks from paid checks or delivery tests. Provider availability is not a startup prerequisite.

Operators create provider accounts and obtain template approval. V1 has no administration dashboard. Exact provider onboarding and live diagnostic commands remain provider-evidence work.

## Observability

Provide structured logs and basic metrics using the [fields below](#diagnostic-fields-and-access). Public lifecycle hooks are deferred; diagnostics are not a durable business-event feed.

Expose `GET /health/live` and `GET /health/ready` on a configurable internal listener in every role. Operators restrict access to health infrastructure. Return 200 with `{ "status": "ok" }` or 503 with `{ "status": "unavailable" }`, without detailed diagnostics.

Liveness requires a responsive process. Readiness requires valid configuration, reachable PostgreSQL, compatible migrated schemas, and initialized role resources. Worker readiness also requires a running processing loop; combined mode must satisfy both roles. Readiness is false during startup and shutdown. Neither check contacts messaging providers or depends on their availability.

Synchronize database and worker clocks. Use monotonic timers for local timeouts and database time for persisted eligibility. Clock corrections must never reopen terminal challenges.

## Cleanup, backups, and late callbacks

Run durable expiry and cleanup work through PostgreSQL-backed jobs. Operations enforce logical expiry immediately; cleanup lag must never extend code validity. A healthy worker checks expired records once per minute by default. Each sweep drains full batches through separate bounded transactions so cleanup throughput is not limited to one batch per minute. Measure cleanup lag and test that sustained load does not starve it.

Backups and external log or metrics systems have their own retention. Keep encryption keys separate from encrypted backups. Restores follow the invalidation procedure above because a backup may resurrect already-consumed challenges or omit later quota usage.

During the seven-day history window, authenticated callbacks may update redacted delivery history without reopening a terminal challenge. After correlation data expires, acknowledge a valid late callback according to the provider protocol and record only bounded redacted diagnostics. Never recreate a deleted challenge from a callback.

## Distribution and licensing

Ship one self-contained router npm package and one standard container image under [MIT](../LICENSE). Export configuration, provider, and selector contracts; keep the core, HTTP, and storage modules private. External adapters may be separate packages.

Distribution remains private under D104. Use local artifacts or an access-controlled registry; public publishing requires a later explicit decision. The private package is `otp-router`. An access-controlled registry is optional; local package and image artifacts are supported. Record separate HTTP, configuration, plugin, and stored-schema compatibility in release metadata.

## Implementation evidence still required

The [release checklist](release-checklist.md) covers migration, cleanup, recovery, key lifecycle, and benchmark evidence. Also verify built-in timeout defaults, worker heartbeat/recovery settings, configuration loading, and the custom-provider deployment template. Provide capacity-based examples for deployment send caps and onboarding instructions for each provider.

[Security](security.md) owns limits and retention; the [data model](data-model.md) owns transaction invariants. Operators own production sizing. Exact monetary accounting remains deferred.

## Diagnostic fields and access

Write JSON logs to standard output with `timestamp`, `level`, `event`, `requestId` where applicable, `challengeId`, `deliveryId`, `providerInstanceId`, normalized `outcome`, allowlisted `reason`, and elapsed milliseconds. Fields irrelevant to an event are omitted. Never include OTPs, credentials, full phone numbers, context IDs, routing context, recipient lookup tokens, message text, authorization headers, raw provider/callback bodies, or Effect causes containing input data. Log defects through a redaction boundary with an internal error category and safe stack locations.

Metrics use bounded labels such as operation, configured provider instance, outcome, and reason. IDs, phones, context, arbitrary provider error text, and request paths containing IDs are forbidden labels. Record counters for creation/verification outcomes, sends, confirmed failures, user resends, uncertainty, suppressed sends, callback authentication failures, quota rejections, and recovery. Record histograms for database operations, queue delay, selector time, and provider waiting time. Expose metrics only through the internal operational listener; detailed diagnostics have no public application API.

## Initial runtime limits and compatibility

Start with 2,000 ms database lock waits and 5,000 ms statement deadlines for ordinary application transactions. Startup migrations have separate bounded waits and deadlines appropriate to the release; ordinary request deadlines do not apply to them. Bound pool acquisition and worker concurrency; never hold an application transaction while running a selector or provider request. Tune pool sizes and lease/heartbeat settings against the selected pg-boss version and record them in release metadata. A timed-out dispatch commit may already have committed: read the delivery record before deciding whether any call is permitted.

Keep pg-boss startup migrations enabled using its supported defaults. The deployment database role needs the permissions to initialize and upgrade the router and queue schemas; separate migration credentials are not mandatory in v1. Pin the dependency version with the release: automatic migration applies that installed version's schema changes, not an automatic package update. Test empty-database startup, concurrent starts, migration interruption, and unsupported schema versions with the selected release. See the [pg-boss constructor reference](https://pgboss.io/api/constructor) and [migration implementation](https://github.com/timgit/pg-boss/blob/master/src/migrationStore.ts).

Use private `0.x.y` package and image releases initially. Patch releases preserve contracts; incompatible changes require a minor version change, migration notes, and an explicit compatibility declaration. Pin images by digest and the deployment's package dependencies by lockfile. No public publish workflow is part of v1. Keep API version, provider contract major, persisted versions, and dependency versions separate in build metadata. Release notes state tested Node.js and PostgreSQL ranges; do not claim support for untested ranges.
