# Local setup

Use the Node.js and pnpm versions in [package.json](../package.json), plus Docker with Compose. Run commands from the repository root. The default configuration uses a fake provider and sends no messages.

## Create secrets once

This refuses to overwrite `.env`. Preserve the file across restarts because stored data depends on its keys.

```sh
node --input-type=module <<'NODE'
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const key = () => randomBytes(32).toString("base64url");
const names = ["API_KEY", "ADMIN_KEY", "FAKE_CALLBACK_SECRET", "ENCRYPTION_KEY",
  "VERIFICATION_KEY", "FINGERPRINT_KEY", "RECIPIENT_KEY"];
const secrets = names.map(name => `OTP_ROUTER_${name}=${key()}\n`).join("");
writeFileSync(".env", `${readFileSync(".env.example", "utf8")}\n${secrets}`,
  { flag: "wx", mode: 0o600 });
NODE
```

## Docker Compose

```sh
docker compose --env-file .env -f apps/server/compose.yaml up --build -d --wait
docker compose --env-file .env -f apps/server/compose.yaml ps
```

The default API is `http://127.0.0.1:3000`; a backend on the Compose network uses `http://router:3000`. Keep internal health/metrics private. Use private networking or TLS for remote backends.

[Compose](../apps/server/compose.yaml) and [.env.example](../.env.example) define ports, mounts, and environment options. Custom entries must be readable by the container's `node` user and bind the application listener to the container interface. Keep their listener ports aligned with Compose's mappings and health check; allow more container shutdown time than the configured application grace period.

For real providers, follow [provider setup](provider-setup.md), select the entry through `OTP_ROUTER_CONFIG_FILE`, and use a separate database and secrets. The demo database belongs to `local-demo`; it cannot be reassigned by changing the deployment ID.

```sh
docker compose --env-file .env -f apps/server/compose.yaml down
```

`down` preserves the database volume; `down --volumes` deletes it. Replace local database credentials before initializing a real deployment; changing the environment does not change an existing PostgreSQL password.

## Host process

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm build
node --env-file=.env apps/server/dist/main.js --check-config --config "$PWD/examples/config/router.config.ts"
node --env-file=.env apps/server/dist/main.js --check-schema --config "$PWD/examples/config/router.config.ts"
node --env-file=.env apps/server/dist/main.js --config "$PWD/examples/config/router.config.ts"
```

`--check-schema` changes the database; neither check sends messages. See [validation](configuration.md#validation) for their scope.

Stop the host process before `pnpm db:down`; the latter preserves its development volume.

## Provision the demo

After either Compose or host startup, follow the [HTTP walkthrough](../examples/http/README.md#provision-the-project-and-route) to provision the project, fake provider, policy, and assignments before sending requests. Startup does not create these resources. The walkthrough exercises managed and external delivery; the fake provider never exposes a usable OTP.

## Custom images

Build custom adapters into the image using the [adapter example](../examples/custom-adapter/README.md).

To verify a local image with disposable PostgreSQL and fake-provider HTTP requests, run:

```sh
docker build -f apps/server/Dockerfile -t otp-router:smoke .
scripts/docker-smoke.sh otp-router:smoke
```

The smoke test uses and removes its own containers and database volume. For published images, follow [deployment and recovery](operations.md).

## Database upgrades

Follow the [database upgrade procedure](operations.md#database-upgrades) when changing versions.
