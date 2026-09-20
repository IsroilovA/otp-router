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

Application logs include `operation` and, for infrastructure failures, `failureCategory`: `database_*` categories distinguish connection, authentication, authorization, syntax, constraint, and concurrency/timeout failures; `queue_operation`, `schema_validation`, and `missing_data` identify other boundaries. Mutation logs include the request ID for correlation. Clients still receive `temporarily_unavailable`; logs omit raw SQL, error messages, causes, and schema input values. Domain rejections carry their normal `reason` without an infrastructure category.

Cleanup enforces bounded retention and erases terminal secrets. Request paths enforce expiry independently of cleanup. Quota usage must survive challenge-history deletion.

Set `workerConcurrency` in the entry file for the deployment's workload. Each process currently has fixed pool limits of 10 application connections and 6 queue connections, including API-only processes; budget PostgreSQL capacity across replicas. Application transactions use a 2-second lock timeout and a 5-second statement timeout. Pool limits, transaction deadlines, retention, and queue recovery timings are implementation settings, not environment-variable knobs. Run the separate capacity benchmark with `pnpm exec vitest run --config vitest.benchmark.config.ts`; historical measurements are in the [research archive](research/benchmark.md).

## Outbound notifications

Configure the destination and independent signing secret as described in [webhooks](webhooks.md). Monitor pending age, expired leases, and failed rows in `otp_router.notifications`. Non-2xx responses and transport failures receive bounded retries; exhausted notifications and their exact event bodies remain for diagnosis. `--replay-webhook <eventId>` queues a failed notification again without any OTP send. Delivered events retain seven days; failed/pending notifications survive challenge deletion.

Backups include immutable events and their delivery state. Restoring can redeliver events the receiver already knows, or roll back a challenge revision relative to the receiver. Event-ID deduplication and highest-revision application remain mandatory; abandon restored authentication flows using the restore procedure. Coordinate webhook destination and signing-secret changes across all roles.

## Deployment checklist

- Use a dedicated PostgreSQL database and durable storage. PostgreSQL 17 is the repository's development and test baseline. The runtime account must create schemas, tables, and indexes and run both router and pg-boss migrations; a DML-only account cannot start the service.
- Back up the complete database, including router, queue, and migration state, and keep the corresponding cryptographic keys in a separate secret store. Exercise restoration with traffic stopped using the procedure above.
- Route backend traffic privately or through TLS. Publish only the selected `/webhooks/<instanceId>` paths for provider callbacks, preserving raw request bodies, query strings, and signature headers. Keep application Bearer keys on the backend and health/metrics private.
- Run at least one worker or combined process. API-only deployments can accept creation requests while deliveries and cleanup wait for a worker.
- Build and pin the deployment image and configuration together. The supplied Compose database password is for local use; changing its environment after database initialization does not change the stored PostgreSQL password.

## Troubleshooting

Start with `docker compose ps` and `docker compose logs --tail=100 router`. Startup logs intentionally contain safe categories rather than raw exception details or credentials. Use the selected entry path with `--check-config` first, then `--check-schema` when database changes are intended.

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
