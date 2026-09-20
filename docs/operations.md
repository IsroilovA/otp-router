# Deployment and operations

Run the combined API/worker or separate roles with the same compatible configuration and plugins. PostgreSQL is the only required external service. Separate deployments must not share router and queue tables.

A trusted TypeScript entry file configures providers, policies, selectors, and limits. Install custom adapter packages when building the image; runtime requests cannot install code or change credentials. Keep secrets outside image layers. See [running](running.md) and [provider setup](provider-setup.md).

## Startup and shutdown

Every role validates configuration, coordinates router migrations, initializes pg-boss, and checks stored compatibility before becoming ready. Keep queue migrations enabled. Never downgrade a newer database schema.

Readiness requires reachable PostgreSQL and initialized role resources, including worker processing where applicable. Liveness requires a responsive process. Neither health check contacts messaging providers.

Shutdown marks the process unready, stops new requests and job claims, then allows in-flight operations to finish within the grace period. On expiry, close connections and interrupt cooperative work. Unresolved dispatched sends retain their reservation and uncertainty. Configure the container shutdown allowance longer than the application grace period.

## Configuration changes

Configuration is immutable during a process lifetime. For incompatible changes, stop creation and let existing challenges finish or expire under the old configuration. Keep verification, callbacks, and workers running during that drain. Stop old workers before starting replacement configuration.

Use a new instance ID for a different provider account. Keep compatible callback credentials while retained history needs them, unless compromise requires immediate revocation. Emergency disables take effect by stopping workers and restarting with the affected instance disabled.

Use rolling deployments only when schemas, queued jobs, plugins, and delivery settings are compatible. Otherwise use planned downtime. Migrations do not make running versions compatible automatically.

## API-key rotation

Deploy old and new API keys to every API process. Switch the backend after all processes accept the new key, then remove the old key. Both keys have identical permissions. Rotation preserves challenge bindings and replay identities.

## Database restore

Stop every API and worker before restoring. Run `--invalidate-restored` to cancel restored active challenges, erase secrets and code fingerprints, and suppress pending delivery work. Late callbacks cannot reopen those challenges.

```sh
node --env-file=.env dist/main.js --invalidate-restored --config "$PWD/examples/config/router.config.ts"
```

A backup can omit recent sends, guesses, and completed operations. Reconstruct complete quota usage from a trusted surviving source, or keep traffic stopped for a full longest quota window from the stop time, at least twenty-four hours. The adopting backend must abandon affected flows and preserve its own business-action consumption rules.

Ordinary restarts with an intact database do not require invalidation.

## Recipient-key replacement

Replace the stable recipient key only through an incident procedure. Stop all roles, invalidate active challenges, and reconcile quotas or wait the full window as above. Install the replacement key consistently, run `--adopt-recipient-key`, and restart only after adoption succeeds. Ordinary encryption-key rotation and database restore do not require recipient-key adoption.

```sh
node --env-file=.env dist/main.js --adopt-recipient-key --config "$PWD/examples/config/router.config.ts"
```

Encryption, verification, and fingerprint-key overlap follow the [security guide](security.md#key-rotation).

## Diagnostics and maintenance

Keep health and Prometheus metrics on the internal listener. Restrict access through deployment networking. JSON logs report operation outcomes and safe failure categories; never log raw errors or sensitive payloads. Use bounded metric labels, not challenge IDs, recipients, or request paths.

Cleanup enforces bounded retention and erases terminal secrets. Request paths enforce expiry independently of cleanup. Quota usage must survive challenge-history deletion.

Tune connection pools, worker concurrency, query deadlines, and queue recovery against the deployment's workload. Run the separate capacity benchmark with `pnpm exec vitest run --config vitest.benchmark.config.ts`; historical measurements are in the [research archive](research/benchmark.md).

Distribution is private. Pin deployment artifacts and preserve exact dependency versions in the lockfile. Verify real provider accounts with explicit authorization and designated recipients before enabling traffic.
