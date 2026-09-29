# Deployment and recovery

Use a dedicated PostgreSQL database and compatible configuration across all roles. Run at least one worker or combined process; an API-only deployment can accept work without delivering it. Pin the image and configuration together, and keep secrets outside image layers.

The [deployment Compose example](../examples/deployment/compose.yaml) runs a combined router with PostgreSQL. Supply these absolute paths:

| Variable | Contents |
| --- | --- |
| `OTP_ROUTER_ENV_FILE` | Router environment file with `DATABASE_URL` using hostname `postgres`, plus the secrets your configuration reads |
| `OTP_ROUTER_POSTGRES_ENV_FILE` | Separate environment file with `POSTGRES_PASSWORD`, matching `DATABASE_URL` |
| `OTP_ROUTER_CONFIG_DIR` | Directory containing `router.config.ts`, or the entry selected by `OTP_ROUTER_CONFIG_FILE` |

Keep secrets outside the repository with restricted permissions. Make configuration readable by the container's `node` user. Set a production deployment identity and [real providers](provider-setup.md) before enabling traffic; the local fake provider sends no messages.

```sh
export OTP_ROUTER_ENV_FILE=/absolute/path/router.env
export OTP_ROUTER_POSTGRES_ENV_FILE=/absolute/path/postgres.env
export OTP_ROUTER_CONFIG_DIR=/absolute/path/config
docker compose -f examples/deployment/compose.yaml up -d --wait
```

The example pins a router version, binds its application port to host loopback, and keeps readiness inside the container. Pin router and PostgreSQL image digests in production and provide TLS or private-network access. `down` retains the database volume; `down --volumes` removes it.

## Startup and shutdown

Allow startup to apply router and queue migrations; the database account needs schema/migration privileges. Never downgrade a newer schema. Readiness requires initialized local resources and PostgreSQL, not messaging-provider availability. Monitor each role independently.

Keep health/metrics private. Stop traffic and new job claims before draining work. Set container shutdown time above the configured `shutdownGraceMs`. Interrupted dispatched sends remain uncertain and retain quota reservations.

## Configuration changes

Changes to the deployment catalog require stopping every API, worker, and combined process using the database before starting replacements with matching configuration. The [catalog fingerprint](../packages/engine/src/config/catalog.ts) defines which settings must match. A different catalog cannot join running replicas, even when the only change is adding a policy that uses existing providers.

For a planned catalog replacement, stop creation and let active operations finish or expire under the old configuration. Keep verification, callbacks, and workers available during the drain. Then stop every old process, install the replacement configuration, and start all roles with that configuration. Confirm readiness before restoring traffic.

Project settings, grants, and lifecycle changes use the [administration API](projects.md) and require no restart. Rolling deployments require an unchanged catalog and compatible schemas, jobs, and plugins; follow the release's upgrade requirements. Backend and administrator credentials can rotate under their existing identities using the [API-key rotation procedure](#api-key-rotation).

Use a new provider instance ID for a different account. The instance's `compatibilityRevision` identifies delivery behavior and non-secret settings that saved routes depend on; change it when those become incompatible. Rotating credentials for the same account does not itself require a revision change. Retain callback credentials throughout the configured history reconciliation window, unless compromise requires revocation.

For an emergency provider disable, skip the planned drain: stop every API, worker, and combined process, then restart all roles with matching configuration and the affected instance disabled. Already committed sends may still complete.

## Database upgrades

Server `0.1.0` deliberately replaces the `0.0.1` router baseline and requires a fresh database. There is no incremental migration, import, backfill, or compatibility path. Old databases are explicitly rejected even when their migration number is also one. The router never resets a database automatically. pg-boss retains its own migration history unchanged.

Before switching, stop creation and drain old operations, verification, callbacks, and history reconciliation using the old release. Preserve the old database and keys for the required reconciliation period. Create a separate empty database for the new release, install matching configuration, initialize it, and provision projects/grants through administration. Point updated callers at the new service only after readiness and provisioning succeed. Do not connect the new release to the old database or treat an old backup as a fresh installation. Later upgrades follow their published release instructions.

## API-key rotation

Deploy old and new keys to every API process, switch callers, then remove the old key. Keep both credentials under the same stable principal; its database grants remain unchanged. Administrator credentials rotate under their stable administrator ID, preserving receipt identity. Rotation preserves replay identities, quotas, and challenge bindings. Other key rotation follows [security](security.md#key-rotation).

## Database restore

Back up the complete database and preserve its cryptographic keys separately. Stop all API and worker processes before restoring, then invalidate restored active flows. In this and the following CLI examples, replace `.env` and the example configuration path with your deployment files:

```sh
node --env-file=.env apps/server/dist/main.js --invalidate-restored --config "$PWD/examples/config/router.config.ts"
```

The adopting backend must abandon affected authentication flows and retain its own business-action consumption records. Late callbacks cannot reopen invalidated operations.

A backup can omit recent sends and guesses. Reconstruct complete quota usage from a trusted surviving source, or keep traffic stopped for the full longest quota window from the stop time, at least twenty-four hours. Ordinary restarts with an intact database need no invalidation.

## Recipient-key replacement

Replace the stable recipient key only as an incident procedure. Stop all roles, invalidate active flows, and reconstruct quota usage or wait the full window as above. Callback correlation and deduplication also use this stable key. After incident replacement, old provider-only references cannot be matched with their former digests; do not treat missing historical correlation as proof of non-delivery. Install the replacement consistently, then adopt it before restarting:

```sh
node --env-file=.env apps/server/dist/main.js --adopt-recipient-key --config "$PWD/examples/config/router.config.ts"
```

Ordinary encryption-key rotation and database restore do not require recipient-key adoption. Never replace existing key bytes under an old ID.

## Outbound notifications

Monitor overdue and failed notifications. Consumers can also reconcile missed events using the [project event feed](history.md). After repairing the receiver, replay a retained failed event:

```sh
node --env-file=.env apps/server/dist/main.js --config "$PWD/examples/config/router.config.ts" --replay-webhook EVENT_UUID
```

Replay restores the notification attempt budget and requeues the original event, never an OTP. Follow [receiver and retention rules](webhooks.md).

## Troubleshooting

Run `docker compose ps` and `docker compose logs --tail=100 router` with the same Compose file, environment, and project used for deployment. Use `--check-config` to validate settings; use `--check-schema` only when database changes are intended.

- Identity mismatch: restore the correct deployment configuration or use a separate database; never bypass the check by deleting needed data.
- Catalog mismatch: compare configuration across roles and follow the [catalog replacement procedure](#configuration-changes).
- Missing retained keys: restore their original IDs and bytes.
- Database/queue startup failure: check reachability, credentials, migration privileges, and artifact/schema compatibility.
- Persistent pending deliveries: check worker availability and configuration across roles.
- Fake delivery remains accepted: expected; the fake provider sends no message or delivery receipt.
- Quota or request conflicts: follow [HTTP retry rules](api.md#idempotency); fresh keys do not bypass limits.

Budget PostgreSQL connections across replicas and worker concurrency. Each role holds one connection for its live catalog registration, leaving nine of the application pool’s ten connections available for request work. Measure capacity for the intended environment with `pnpm exec vitest run --config vitest.benchmark.config.ts`; local measurements are not production guarantees.
