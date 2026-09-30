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

Keep health/metrics private. Stop traffic and new job claims before draining work. Set container shutdown time above the configured `shutdownGraceMs`. When the queue signals that a job has expired or lost its claim, only that handler is interrupted. Shutdown interrupts remaining work after its grace period and waits for cleanup. Interrupted dispatched sends remain uncertain and retain quota reservations.

## Configuration changes

Account, instance, policy, assignment, limit, and credential changes use [runtime administration](runtime-configuration.md) without a restart. Disable an account or instance through administration for an emergency stop. Already committed sends may still complete.

The [deployment-capability fingerprint](../packages/engine/src/config/capabilities.ts) identifies executable adapters and schema support, versioned selectors, identities, permission ceilings, and safety settings. All live replicas must agree. Runtime edits do not change the fingerprint. A code upgrade must support every retained configuration and callback; incompatible upgrades require draining the old deployment.

For an incompatible replacement, stop creation and let active operations finish or expire. Preserve verification, callbacks, workers, and history reconciliation for their required retention window. Then stop every old process before installing replacement capabilities. Keep the old database and keys if reconciliation must continue separately. Confirm readiness before restoring traffic. Never remove an adapter or callback key still required by retained work.

A new upstream account requires a new account identity. Ordinary sender/template edits create immutable instance revisions and affect new operations only. Explicitly invalidate saved revisions that can no longer execute. Re-enabling or regranting never revives old intents. Backend and administrator credentials rotate under stable identities using the [API-key procedure](#api-key-rotation).

## Database upgrades

Server `0.2.0` requires a fresh database using the [initial router baseline](../packages/engine/src/database/migrations/0001_initial.ts), `runtime-model-v3`. Databases from published `0.1.0` and earlier releases or superseded development baselines are rejected, even when their migration number is also one. There is no incremental migration, import, or backfill, and the router never resets a database automatically. pg-boss manages its own schema initialization and migration history.

Coordinate the server, client, deployment configuration, and strict authorization/event consumers using the [replacement release notes](releases.md#pending-breaking-replacement).

Before switching, stop creation and drain old operations, verification, callbacks, and history reconciliation using the old release. Preserve the old database and keys for the required reconciliation period. Create a separate empty database for the new release, install matching configuration, initialize it, and provision projects, runtime providers/policies, and explicit assignments through administration. Point updated callers at the new service only after readiness and provisioning succeed. Never resubmit uncertain sends while moving traffic. Do not connect the new release to the old database or treat an old backup as a fresh installation. Later upgrades follow their published release instructions.

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
- Capability mismatch: compare executable contracts across roles and follow the [deployment replacement procedure](#configuration-changes).
- Missing retained keys: restore their original IDs and bytes.
- Database/queue startup failure: check reachability, credentials, migration privileges, and artifact/schema compatibility.
- Persistent pending deliveries: check worker availability and configuration across roles.
- Fake delivery remains accepted: expected; the fake provider sends no message or delivery receipt.
- Quota or request conflicts: follow [HTTP retry rules](api.md#idempotency); fresh keys do not bypass limits.

Budget PostgreSQL connections across replicas and worker concurrency. Each role holds one connection for its live capability registration, leaving nine of the application pool’s ten connections available for request work. Measure capacity for the intended environment with `pnpm exec vitest run --config vitest.benchmark.config.ts`; local measurements are not production guarantees.
