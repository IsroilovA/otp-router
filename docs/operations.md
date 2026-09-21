# Deployment and operations

Run the combined API/worker or separate roles with the same compatible configuration and plugins. PostgreSQL is the only required external service. Separate deployments must not share router and queue tables.

A trusted TypeScript entry file configures providers, policies, selectors, and limits. Install custom adapter packages when building the image; runtime requests cannot install code or change credentials. Keep secrets outside image layers. See [running](running.md) and [provider setup](provider-setup.md).

## Startup and shutdown

Every role validates configuration, coordinates router migrations, initializes pg-boss, and checks stored compatibility before becoming ready. Keep queue migrations enabled. Never downgrade a newer database schema.

Readiness requires reachable PostgreSQL and initialized role resources, including worker processing where applicable. Liveness requires a responsive process. Neither health check contacts messaging providers.

The internal listener defaults to `127.0.0.1:3001`: `GET /health/live` returns 200, `GET /health/ready` returns 200 or 503, and `GET /metrics` exposes Prometheus text. Before startup finishes, the listener may not yet accept connections. Compose probes readiness inside the container. API-only readiness does not establish that a separate worker is running; monitor each role.

Shutdown marks the process unready, stops new requests and job claims, then allows in-flight operations to finish within the grace period. On expiry, close connections and interrupt cooperative work. Unresolved dispatched sends retain their reservation and uncertainty. Configure the container shutdown allowance longer than the application grace period.

## Configuration changes

Configuration is immutable during a process lifetime. For incompatible changes, stop creation and let existing challenges finish or expire under the old configuration. Keep verification, callbacks, and workers running during that drain. Stop old workers before starting replacement configuration.

Use a new instance ID for a different provider account. Keep compatible callback credentials while retained history needs them, unless compromise requires immediate revocation. Emergency disables take effect by stopping workers and restarting with the affected instance disabled.

Use rolling deployments only when schemas, queued jobs, plugins, and delivery settings are compatible. Otherwise use planned downtime. Migrations do not make running versions compatible automatically.

## API-key rotation

Deploy old and new API keys to every API process. Switch the backend after all processes accept the new key, then remove the old key. Both keys have identical permissions. Rotation preserves challenge bindings and replay identities.

## Database restore

Stop every API and worker before restoring. Run `--invalidate-restored` to close restored prepared/active delivery operations, cancel linked challenges, erase secrets and code fingerprints, and suppress pending work. Late callbacks cannot reopen them.

```sh
node --env-file=.env apps/server/dist/main.js --invalidate-restored --config "$PWD/examples/config/router.config.ts"
```

A backup can omit recent sends, guesses, and completed operations. Reconstruct complete quota usage from a trusted surviving source, or keep traffic stopped for a full longest quota window from the stop time, at least twenty-four hours. The adopting backend must abandon affected flows and preserve its own business-action consumption rules.

Ordinary restarts with an intact database do not require invalidation.

## Recipient-key replacement

Replace the stable recipient key only through an incident procedure. Stop all roles, invalidate active challenges, and reconcile quotas or wait the full window as above. Install the replacement key consistently, run `--adopt-recipient-key`, and restart only after adoption succeeds. Ordinary encryption-key rotation and database restore do not require recipient-key adoption.

```sh
node --env-file=.env apps/server/dist/main.js --adopt-recipient-key --config "$PWD/examples/config/router.config.ts"
```

Encryption, verification, and fingerprint-key overlap follow the [security guide](security.md#key-rotation).

## Diagnostics and maintenance

Keep health and Prometheus metrics on the internal listener. Restrict access through deployment networking. JSON logs report operation outcomes and safe failure categories; never log raw errors or sensitive payloads. Use bounded metric labels, not challenge IDs, recipients, or request paths.

Application mutation logs identify the operation and request ID. Worker failure logs identify the queue, job and safe failure category, distinguishing infrastructure failures, defects and interruption. Neither includes raw SQL, error causes or sensitive payloads. Clients receive stable public errors.

Startup and maintenance reconcile abandoned dispatches even when their queue jobs have exhausted retries. Recovery records uncertainty and never invokes a provider. Cleanup enforces [retention](data-model.md#replay-and-retention); request paths enforce expiry independently.

Set `workerConcurrency` for the deployment's workload and budget PostgreSQL connections across all replicas, including API-only processes. Pool sizes and transaction deadlines live in the resource configuration. Run the separate capacity benchmark with `pnpm exec vitest run --config vitest.benchmark.config.ts` when evaluating deployment capacity; [historical measurements](research/benchmark.md) are context, not a capacity guarantee.

## Outbound notifications

Monitor pending age, expired leases and failed notifications. Follow [webhook configuration and replay](webhooks.md) to diagnose receiver failures and requeue retained events.

Backups include immutable events and their delivery state. Restoring can redeliver events the receiver already knows, or roll back a challenge revision relative to the receiver. Event-ID deduplication and highest-revision application remain mandatory; abandon restored authentication flows using the restore procedure. Coordinate webhook destination and signing-secret changes across all roles.

## Deployment checklist

- Use a dedicated PostgreSQL database and durable storage. The runtime account must create schemas, tables, and indexes and run both router and pg-boss migrations; a DML-only account cannot start the service.
- Back up the complete database, including router, queue, and migration state, and keep the corresponding cryptographic keys in a separate secret store. Exercise restoration with traffic stopped using the procedure above.
- Route backend traffic privately or through TLS. Publish only the selected `/webhooks/<instanceId>` paths for provider callbacks, preserving raw request bodies, query strings, and signature headers. Keep application Bearer keys on the backend and health/metrics private.
- Run at least one worker or combined process. API-only deployments can accept creation requests while deliveries and cleanup wait for a worker.
- Build and pin the deployment image and configuration together. The supplied Compose database password is for local use; changing its environment after database initialization does not change the stored PostgreSQL password.

## Troubleshooting

Start with `docker compose -f apps/server/compose.yaml ps` and `docker compose -f apps/server/compose.yaml logs --tail=100 router`. Startup logs intentionally contain safe categories rather than raw exception details or credentials. Use the selected entry path with `--check-config` first, then `--check-schema` when database changes are intended.

| Symptom or log reason | Check |
| --- | --- |
| `configuration_module_failed` | Entry path, readability by the container's `node` user, missing required environment variables, and installed imports. |
| `invalid_settings`, `invalid_keys` | Required settings, API-key length, canonical 32-byte keys, and independence of every key. |
| `deployment_identity_changed` | Wrong database or changed deployment ID; restore the original configuration or use a separate database. |
| `retained_key_missing` | Restore the retained key IDs and original bytes; do not generate replacements under old IDs. |
| `recipient_key_changed_requires_incident_procedure` | Restore the original recipient key or follow the incident procedure. |
| `SqlError`, `QueueLifecycleError`, `SchemaCompatibilityError` | Database reachability, credentials, migration privileges, and compatible schema/artifact versions. |
| `pending` deliveries persist | Worker availability, worker readiness/logs, and the same database/configuration across roles. |
| Fake delivery stays `accepted` | Expected: the fake provider neither delivers a message nor generates a delivery receipt. |
| 429 `cooldown_active` or `rate_limited` | Respect `Retry-After`, inspect current action forecasts, and wait; new idempotency keys do not bypass limits. |
| 409 `idempotency_conflict` | Retry with the original validated body or use a fresh key only for an intended new action. |

Distribution is private. Pin deployment artifacts and preserve exact dependency versions in the lockfile. Verify real provider accounts with explicit authorization and designated recipients before enabling traffic.
