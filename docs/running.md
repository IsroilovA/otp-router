# Running OTP Router

Run these commands from a checkout of the repository. The setup below uses Node.js 24 or newer to generate secrets and run the request examples, and Docker with Compose for the service and PostgreSQL. Running the service on the host also requires pnpm 12.5.1. The default local database uses PostgreSQL 17 on `127.0.0.1:54329`.

Create the local environment and independent keys once. The command refuses to overwrite an existing `.env`; keep that file across restarts because existing data depends on its keys. The named development database volume persists until it is removed separately:

```sh
node --input-type=module <<'NODE'
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const key = () => randomBytes(32).toString("base64url");
const names = ["API_KEY", "FAKE_CALLBACK_SECRET", "ENCRYPTION_KEY",
  "VERIFICATION_KEY", "FINGERPRINT_KEY", "RECIPIENT_KEY"];
const secrets = names.map(name => `OTP_ROUTER_${name}=${key()}\n`).join("");
writeFileSync(".env", `${readFileSync(".env.example", "utf8")}\n${secrets}`,
  { flag: "wx", mode: 0o600 });
NODE
```

## Docker Compose

Start PostgreSQL and the combined HTTP API/worker with:

```sh
docker compose --env-file .env -f apps/server/compose.yaml up --build -d --wait
docker compose --env-file .env -f apps/server/compose.yaml ps
```

The API listens at `http://127.0.0.1:3000`. Compose waits for PostgreSQL health before starting the router, then waits for router readiness after migrations and queue initialization. pg-boss runs inside the router and uses the same PostgreSQL database. Its health listener stays inside the application container. Compose allows forty seconds for shutdown, covering the default thirty-second application grace period; increase `stop_grace_period` if you configure a longer grace period.

The default configuration uses the fake provider and sends no real messages. Compose reads secrets from `.env`, mounts `examples/config` read-only, and overrides `DATABASE_URL` with the internal `postgres:5432` address. The database credentials in this file are for local development. For a deployed environment, replace the PostgreSQL password and the matching router connection URL together before initializing its database.

To use real providers, prepare the entry file and credentials described in [provider setup](provider-setup.md). Set `OTP_ROUTER_CONFIG_FILE=builtins.config.ts` in `.env` to select the supplied built-in example. Remove unused providers and adjust policies before starting it. `OTP_ROUTER_CONFIG_DIR` selects a different host configuration directory; relative paths resolve from `apps/server`; it must exist and be readable by the container's `node` user. The entry file must bind the API to `0.0.0.0` inside the container; both supplied examples honor `OTP_ROUTER_HOST` for this. Keep its API and health ports at 3000 and 3001 unless you also update Compose's ports and health check.

Use a separate database and secrets for a real deployment. The demo binds its database to deployment ID `local-demo`; changing to a different `OTP_ROUTER_DEPLOYMENT_ID` against that volume fails startup. Even `--check-schema` initializes this identity. See [configuration and database identity](configuration.md#database-identity).

`OTP_ROUTER_PORT` changes the host API port, and `OTP_ROUTER_POSTGRES_PORT` changes the host database port. Both default to loopback-only bindings. A backend on the host uses `http://127.0.0.1:3000`; a backend attached to this Compose network uses `http://router:3000`. For a backend on another machine, configure private networking or a TLS reverse proxy. Do not publish the internal health listener. `OTP_ROUTER_ENV_FILE` selects another secrets file; also pass that file with `docker compose --env-file <path> -f apps/server/compose.yaml` if it contains Compose settings such as the selected configuration filename.

Check configuration or stop the stack with:

```sh
docker compose --env-file .env -f apps/server/compose.yaml run --rm --no-deps router node apps/server/dist/main.js --check-config --config /app/apps/server/config/router.config.ts
docker compose --env-file .env -f apps/server/compose.yaml down
```

Use the selected entry filename in the check command. `down` preserves the named database volume; `down --volumes` deletes it. Startup automatically applies migrations, so no separate migration or queue container is required.

## Running on the host

To run Node.js directly while keeping PostgreSQL in Docker, start only the database, build the service, and check configuration before starting it:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm build
node --env-file=.env apps/server/dist/main.js --check-config --config "$PWD/examples/config/router.config.ts"
node --env-file=.env apps/server/dist/main.js --check-schema --config "$PWD/examples/config/router.config.ts"
node apps/server/dist/main.js --openapi > openapi.json
node --env-file=.env apps/server/dist/main.js --config "$PWD/examples/config/router.config.ts"
```

The example configuration requires `OTP_ROUTER_API_KEY`, `OTP_ROUTER_FAKE_CALLBACK_SECRET`, and four independent 32-byte base64url keys. See [the example configuration](../examples/config/README.md). The fake provider is deterministic and local. It does not send a real message or require provider credentials.

The runtime loads one TypeScript configuration entry file. `--check-config` validates startup configuration without accepting traffic or connecting to PostgreSQL. `--check-schema` applies migrations, initializes queues and database identity, and validates stored compatibility; it changes the database and requires migration privileges. `--openapi` writes the generated OpenAPI document to standard output and exits without loading configuration or connecting to PostgreSQL. `--invalidate-restored` is reserved for the documented restore procedure and must be used only while application traffic and workers are stopped. See [configuration](configuration.md) for settings and CLI modes.

For restore invalidation, recipient-key replacement, and key rotation, follow the [operations guide](operations.md).

The combined role is the default. Set `role` to `api` or `worker` in the configuration for separate processes. Readiness remains false until local configuration, PostgreSQL, router migrations, pg-boss initialization, and the selected role resources are ready. Provider outages do not make local readiness fail.

Run the checks and tests with:

```sh
pnpm check
pnpm test
```

Run a focused suite with `pnpm exec vitest run tests/process.test.ts`. Tests own disposable databases and fake providers; they do not use the development database.

Stop the local database when finished. The command preserves its named development volume:

```sh
pnpm db:down
```

## Try the API

Follow the [integration flow](api.md#integration-flow) for challenge creation, updates and completion. The fake provider accepts sends without delivering a code.

## Standalone container

On Docker Desktop, start PostgreSQL with `pnpm db:up`, then build the image and mount a configuration directory containing `router.config.ts`. Stop any router already using ports 3000/3001 first:

```sh
docker build -f apps/server/Dockerfile -t otp-router:local .
docker run --rm --stop-timeout 40 --env-file .env \
  -e DATABASE_URL=postgres://otp_router:local-development-only@host.docker.internal:54329/otp_router \
  -e OTP_ROUTER_HOST=0.0.0.0 \
  -e OTP_ROUTER_INTERNAL_HOST=0.0.0.0 \
  -v "$PWD/examples/config:/app/apps/server/config:ro" \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 otp-router:local
```

This command uses Docker Desktop's `host.docker.internal` to reach the host-published database. On Linux Engine, use a database reachable from the container network; do not assume a host loopback-only database port is reachable through a gateway alias. Compose handles this networking directly.

The image is private and has no publish workflow. Custom adapters belong in a separate deployment image. See [the custom adapter fixture](../examples/custom-adapter/README.md).
