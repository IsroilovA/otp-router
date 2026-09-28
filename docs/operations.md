# Deployment and recovery

Use a dedicated PostgreSQL database and compatible configuration across all roles. Run at least one worker or combined process; an API-only deployment can accept work without delivering it. Pin the image and configuration together, and keep secrets outside image layers.

## Startup and shutdown

Allow startup to apply router and queue migrations; the database account needs schema/migration privileges. Never downgrade a newer schema. Readiness requires initialized local resources and PostgreSQL, not messaging-provider availability. Monitor each role independently.

Keep health/metrics private. Stop traffic and new job claims before draining work; allow the container more shutdown time than the application grace period. Interrupted dispatched sends remain uncertain and retain quota reservations.

## Configuration changes

For incompatible changes, stop creation and let active operations finish or expire under the old configuration. Keep verification, callbacks, and workers available during the drain. Stop old workers before starting replacement configuration. Use rolling deployments only when schemas, jobs, plugins, and settings remain compatible.

Use a new provider instance ID for a different account. Update the non-secret settings fingerprint for incompatible delivery changes and retain callback credentials while history needs them, unless compromise requires revocation. Emergency disables require stopping workers and restarting with the affected instance disabled.

## API-key rotation

Deploy old and new keys to every API process, switch callers, then remove the old key. Both credentials have identical privileges. Rotation must preserve replay identities, quotas, and challenge bindings. Other key rotation follows [security](security.md#key-rotation).

## Database restore

Back up the complete database and preserve its cryptographic keys separately. Stop all API and worker processes before restoring, then invalidate restored active flows:

```sh
node --env-file=.env apps/server/dist/main.js --invalidate-restored --config "$PWD/examples/config/router.config.ts"
```

The adopting backend must abandon affected authentication flows and retain its own business-action consumption records. Late callbacks cannot reopen invalidated operations.

A backup can omit recent sends and guesses. Reconstruct complete quota usage from a trusted surviving source, or keep traffic stopped for the full longest quota window from the stop time, at least twenty-four hours. Ordinary restarts with an intact database need no invalidation.

## Recipient-key replacement

Replace the stable recipient key only as an incident procedure. Stop all roles, invalidate active flows, and reconstruct quota usage or wait the full window as above. Install the replacement consistently, then adopt it before restarting:

```sh
node --env-file=.env apps/server/dist/main.js --adopt-recipient-key --config "$PWD/examples/config/router.config.ts"
```

Ordinary encryption-key rotation and database restore do not require recipient-key adoption. Never replace existing key bytes under an old ID.

## Outbound notifications

Monitor overdue and failed notifications. After repairing the receiver, replay a retained failed event:

```sh
node --env-file=.env apps/server/dist/main.js --config "$PWD/examples/config/router.config.ts" --replay-webhook EVENT_UUID
```

Replay restores the notification attempt budget and requeues the original event, never an OTP. Follow [receiver and retention rules](webhooks.md).

## Troubleshooting

Start with `docker compose -f apps/server/compose.yaml ps` and `docker compose -f apps/server/compose.yaml logs --tail=100 router`. Use `--check-config` to validate local settings; use `--check-schema` only when database changes are intended.

- Identity mismatch: restore the correct deployment configuration or use a separate database; never bypass the check by deleting needed data.
- Missing retained keys: restore their original IDs and bytes.
- Database/queue startup failure: check reachability, credentials, migration privileges, and artifact/schema compatibility.
- Persistent pending deliveries: check worker availability and configuration across roles.
- Fake delivery remains accepted: expected; the fake provider sends no message or delivery receipt.
- Quota or request conflicts: follow [HTTP retry rules](api.md#idempotency); fresh keys do not bypass limits.

Budget PostgreSQL connections across replicas and worker concurrency. Measure capacity for the intended environment with `pnpm exec vitest run --config vitest.benchmark.config.ts`; local measurements are not production guarantees.
