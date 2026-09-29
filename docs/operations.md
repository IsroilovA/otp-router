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

For incompatible changes, stop creation and let active operations finish or expire under the old configuration. Keep verification, callbacks, and workers available during the drain. Stop old workers before starting replacement configuration. Use rolling deployments only when schemas, jobs, plugins, and settings remain compatible.

Use a new provider instance ID for a different account. The instance's `compatibilityRevision` identifies delivery behavior and non-secret settings that saved routes depend on; change it when those become incompatible. Rotating credentials for the same account does not itself require a revision change. Retain callback credentials throughout the configured history reconciliation window, unless compromise requires revocation. Emergency disables require stopping workers and restarting with the affected instance disabled.

## Database upgrades

Releases that change the router schema include ordered migrations and any required backfills. Startup applies pending migrations to an existing database; a fresh installation applies the complete migration history. Database resets are not an upgrade procedure.

Before upgrading, read the release notes for supported source versions, compatibility, and any drain requirements. Back up the database and preserve its keys, then validate the upgrade on a restored copy. Stop incompatible API and worker processes before applying migrations; never mix incompatible builds against the same database. Confirm readiness before restoring traffic. To recover from an incompatible upgrade, restore the matching database backup, application version, configuration, and keys using the [database restore procedure](#database-restore); do not run older code against the newer schema.

## API-key rotation

Deploy old and new keys to every API process, switch callers, then remove the old key. Keep both credentials under the same service principal and project grants. Rotation preserves replay identities, quotas, and challenge bindings. Other key rotation follows [security](security.md#key-rotation).

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
- Missing retained keys: restore their original IDs and bytes.
- Database/queue startup failure: check reachability, credentials, migration privileges, and artifact/schema compatibility.
- Persistent pending deliveries: check worker availability and configuration across roles.
- Fake delivery remains accepted: expected; the fake provider sends no message or delivery receipt.
- Quota or request conflicts: follow [HTTP retry rules](api.md#idempotency); fresh keys do not bypass limits.

Budget PostgreSQL connections across replicas and worker concurrency. Measure capacity for the intended environment with `pnpm exec vitest run --config vitest.benchmark.config.ts`; local measurements are not production guarantees.
