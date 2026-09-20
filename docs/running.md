# Running OTP Router

OTP Router needs Node.js 24 or newer, pnpm 12.5.1, and PostgreSQL. The default local database uses PostgreSQL 17 on `127.0.0.1:54329`.

Create the local environment and independent keys once. Keep this file across restarts; rerunning these commands would replace the keys needed by existing data. The named development database volume persists until it is removed separately:

```sh
cp .env.example .env
chmod 600 .env
node --input-type=module >> .env <<'NODE'
import { randomBytes } from "node:crypto";
const key = () => randomBytes(32).toString("base64url");
process.stdout.write(`OTP_ROUTER_API_KEY=${randomBytes(24).toString("base64url")}\n`);
process.stdout.write(`OTP_ROUTER_FAKE_CALLBACK_SECRET=${key()}\n`);
process.stdout.write(`OTP_ROUTER_ENCRYPTION_KEY=${key()}\n`);
process.stdout.write(`OTP_ROUTER_VERIFICATION_KEY=${key()}\n`);
process.stdout.write(`OTP_ROUTER_FINGERPRINT_KEY=${key()}\n`);
process.stdout.write(`OTP_ROUTER_RECIPIENT_KEY=${key()}\n`);
NODE
```

## Docker Compose

Start PostgreSQL and the combined HTTP API/worker with:

```sh
docker compose up --build -d --wait
docker compose ps
```

The API listens at `http://127.0.0.1:3000`. Compose waits for PostgreSQL health before starting the router, then waits for router readiness after migrations and queue initialization. pg-boss runs inside the router and uses the same PostgreSQL database. Its health listener stays inside the application container. Compose allows forty seconds for shutdown, covering the default thirty-second application grace period; increase `stop_grace_period` if you configure a longer grace period.

The default configuration uses the fake provider and sends no real messages. Compose reads secrets from `.env`, mounts `examples/config` read-only, and overrides `DATABASE_URL` with the internal `postgres:5432` address. The database credentials in this file are for local development. For a deployed environment, replace the PostgreSQL password and the matching router connection URL together before initializing its database.

To use real providers, prepare the entry file and credentials described in [provider setup](provider-setup.md). Set `OTP_ROUTER_CONFIG_FILE=builtins.config.ts` in `.env` to select the supplied built-in example. Remove unused providers and adjust policies before starting it. `OTP_ROUTER_CONFIG_DIR` selects a different host configuration directory; it must exist and be readable by the container's `node` user. The entry file must bind the API to `0.0.0.0` inside the container; both supplied examples honor `OTP_ROUTER_HOST` for this. Keep its API and health ports at 3000 and 3001 unless you also update Compose's ports and health check.

`OTP_ROUTER_PORT` changes the host API port, and `OTP_ROUTER_POSTGRES_PORT` changes the host database port. Both default to loopback-only bindings. A backend on the host uses `http://127.0.0.1:3000`; a backend attached to this Compose network uses `http://router:3000`. For a backend on another machine, configure private networking or a TLS reverse proxy. Do not publish the internal health listener. `OTP_ROUTER_ENV_FILE` selects another secrets file; also pass that file with `docker compose --env-file <path>` if it contains Compose settings such as the selected configuration filename.

Check configuration or stop the stack with:

```sh
docker compose run --rm --no-deps router node dist/main.js --check-config --config /app/config/router.config.ts
docker compose down
```

Use the selected entry filename in the check command. `down` preserves the named database volume; `down --volumes` deletes it. Startup automatically applies migrations, so no separate migration or queue container is required.

## Running on the host

To run Node.js directly while keeping PostgreSQL in Docker, start only the database, build the service, and check configuration before starting it:

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm build
node --env-file=.env dist/main.js --check-config --config "$PWD/examples/config/router.config.ts"
node --env-file=.env dist/main.js --check-schema --config "$PWD/examples/config/router.config.ts"
node dist/main.js --openapi > openapi.json
node --env-file=.env dist/main.js --config "$PWD/examples/config/router.config.ts"
```

The example configuration requires `OTP_ROUTER_API_KEY`, `OTP_ROUTER_FAKE_CALLBACK_SECRET`, and four independent 32-byte base64url keys. See [the example configuration](../examples/config/README.md). The fake provider is deterministic and local. It does not send a real message or require provider credentials.

The runtime loads one TypeScript configuration entry file. `--check-config` validates startup configuration without accepting traffic. `--check-schema` validates the router and queue schema prerequisites. `--openapi` writes the generated OpenAPI document to standard output and exits without loading configuration or connecting to PostgreSQL. `--invalidate-restored` is reserved for the documented restore procedure and must be used only while application traffic and workers are stopped.

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

Use `POST /v1/challenges` with an E.164 phone number, a configured purpose and policy, a context ID, an API key, and an `Idempotency-Key`. The create response means that the delivery job committed. Check the challenge endpoint for later delivery state. Verification does not require a provider receipt. Keep request and response bodies out of logs, and never use a real recipient without explicit authorization.

A backend should reuse the same key and validated body after a lost response. The replay returns the saved result and does not queue another delivery. Use a new key for a new action. A minimal TypeScript client is:

```ts
const body = {
  recipient: { type: "phone", phoneNumber: "+14155552671" },
  purpose: "login",
  contextId: "example-flow-1",
  policyId: "login",
};
const headers = {
  authorization: `Bearer ${process.env.OTP_ROUTER_API_KEY}`,
  "content-type": "application/json",
  "idempotency-key": "create-example-flow-1",
};
const first = await fetch("http://127.0.0.1:3000/v1/challenges", {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});
const replay = await fetch("http://127.0.0.1:3000/v1/challenges", {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});
console.log(first.status, replay.status, replay.headers.get("Idempotency-Replayed"));
```

For the curl commands, load the API key from the same local environment file:

```sh
export OTP_ROUTER_API_KEY="$(node --env-file=.env -p 'process.env.OTP_ROUTER_API_KEY')"
```

A request with curl is:

```sh
curl -sS -X POST http://127.0.0.1:3000/v1/challenges \
  -H "Authorization: Bearer $OTP_ROUTER_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-example-flow-1' \
  --data '{"recipient":{"type":"phone","phoneNumber":"+14155552671"},"purpose":"login","contextId":"example-flow-1","policyId":"login"}'
```

Repeat the same request to replay it. Use a new key for an intended resend, selection, or cancellation. See [HTTP integration](api.md).

For a container run, build the image and mount a configuration directory containing `router.config.ts`:

```sh
docker build -t otp-router:local .
docker run --rm --env-file .env \
  -e DATABASE_URL=postgres://otp_router:local-development-only@host.docker.internal:54329/otp_router \
  -e OTP_ROUTER_HOST=0.0.0.0 \
  -e OTP_ROUTER_INTERNAL_HOST=0.0.0.0 \
  -v "$PWD/examples/config:/app/config:ro" \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 otp-router:local
```

The image is private and has no publish workflow. Custom adapters belong in a separate deployment image. See [the custom adapter fixture](../examples/custom-adapter/README.md).
