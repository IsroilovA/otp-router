# Running OTP Router

OTP Router needs Node.js 24 or newer, pnpm 12.5.1, and PostgreSQL. The default local database uses PostgreSQL 17 on `127.0.0.1:54329`.

Install and start the local PostgreSQL container. Its named development volume persists until it is removed separately:

```sh
pnpm install --frozen-lockfile
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
pnpm db:up
```

Build the service, then run the configuration checks before starting it:

```sh
pnpm build
node --env-file=.env dist/main.js --check-config --config "$PWD/examples/config/router.config.ts"
node --env-file=.env dist/main.js --check-schema --config "$PWD/examples/config/router.config.ts"
node dist/main.js --openapi > openapi.json
node --env-file=.env dist/main.js --config "$PWD/examples/config/router.config.ts"
```

The example configuration requires `OTP_ROUTER_API_KEY`, `OTP_ROUTER_FAKE_CALLBACK_SECRET`, and four independent 32-byte base64url keys. See [the example configuration](../examples/config/README.md). The fake provider is deterministic and local. It does not send a real message or require provider credentials.

The runtime loads one TypeScript configuration entry file. `--check-config` validates startup configuration without accepting traffic. `--check-schema` validates the router and queue schema prerequisites. `--openapi` writes the generated OpenAPI document to standard output and exits without loading configuration or connecting to PostgreSQL. `--invalidate-restored` is reserved for the documented restore procedure and must be used only while application traffic and workers are stopped.

After a database restore, stop every API and worker, run `--invalidate-restored`, and keep traffic stopped while quota usage is reconciled from a trusted surviving source. If complete usage cannot be reconstructed, wait the longest configured quota window, at least 24 hours, from the recorded stop time. Use `--adopt-recipient-key` only when the stable recipient key itself was replaced as part of the documented incident procedure. That procedure must install the replacement recipient key consistently and must not reset quotas automatically. Ordinary restore invalidation does not require recipient-key adoption.

The incident-only sequence is:

```sh
node --env-file=.env dist/main.js --invalidate-restored --config "$PWD/examples/config/router.config.ts"
# Reconcile quota usage, or wait at least 24 hours while traffic stays stopped.
node --env-file=.env dist/main.js --adopt-recipient-key --config "$PWD/examples/config/router.config.ts"
```

Run the second command only after replacing the configured recipient key consistently across every role. It validates the adoption state and exits; it does not start API or worker traffic.

The combined role is the default. Set `role` to `api` or `worker` in the configuration for separate processes. Readiness remains false until local configuration, PostgreSQL, router migrations, pg-boss initialization, and the selected role resources are ready. Provider outages do not make local readiness fail.

Run the checks and tests with:

```sh
pnpm check
pnpm test
```

To reproduce HTTP creation, a real queued worker send, and correct-code verification without a provider account, run:

```sh
pnpm exec vitest run tests/process.test.ts
```

This test builds the service, creates its own disposable PostgreSQL container, and starts independent API and worker processes. Its deterministic provider records the generated code in a mode-600 temporary sink for verification, then the test removes the sink, processes, and container. It also tests concurrent API processes, worker death, database readiness during an outage, and shutdown with unfinished work. It needs no `.env` and does not use the persistent development database.

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

The equivalent curl request and replay are:

```sh
curl -sS -X POST http://127.0.0.1:3000/v1/challenges \
  -H "Authorization: Bearer $OTP_ROUTER_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-example-flow-1' \
  --data '{"recipient":{"type":"phone","phoneNumber":"+14155552671"},"purpose":"login","contextId":"example-flow-1","policyId":"login"}'

curl -sS -X POST http://127.0.0.1:3000/v1/challenges \
  -H "Authorization: Bearer $OTP_ROUTER_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-example-flow-1' \
  --data '{"recipient":{"type":"phone","phoneNumber":"+14155552671"},"purpose":"login","contextId":"example-flow-1","policyId":"login"}'
```

Delivery actions use a new key per intended action. For example, resend and its safe replay are:

```sh
curl -sS -X POST http://127.0.0.1:3000/v1/challenges/$CHALLENGE_ID/deliveries \
  -H "Authorization: Bearer $OTP_ROUTER_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: resend-example-flow-1' \
  --data '{"action":"resend"}'

curl -sS -X POST http://127.0.0.1:3000/v1/challenges/$CHALLENGE_ID/deliveries \
  -H "Authorization: Bearer $OTP_ROUTER_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: resend-example-flow-1' \
  --data '{"action":"resend"}'
```

For a container run, build the image and mount a configuration directory containing `router.config.ts`:

```sh
docker build -t otp-router:local .
docker run --rm --env-file .env \
  -e DATABASE_URL=postgres://otp_router:local-development-only@host.docker.internal:54329/otp_router \
  -e OTP_ROUTER_HOST=0.0.0.0 \
  -e OTP_ROUTER_INTERNAL_HOST=0.0.0.0 \
  -v "$PWD/examples/config:/app/config:ro" \
  -p 3000:3000 -p 3001:3001 otp-router:local
```

The image is private and has no publish workflow. Custom adapters belong in a separate deployment image. See [the custom adapter fixture](../examples/custom-adapter/README.md).

The custom adapter fixture was verified locally on 2026-09-20 against the packed `otp-router` 0.1.0 artifact. A temporary host install compiled the fixture with TypeScript 7.0.2, then loaded the emitted module, ran the selector for `+14155552671`, built the provider Layer, and called its deterministic send. The observed host result was `{"selector":"Route","provider":"custom_text_sink"}`. The same smoke entrypoint ran inside the built custom image and returned the same result. The temporary install and image context were removed after the run. The standard image `otp-router-v1-local:verification` also starts on Node 24.21.0. These checks verify package and custom-image boundaries only; they do not verify a real provider send or a production image release.
