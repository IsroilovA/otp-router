# OTP Router

OTP Router is a private self-hosted HTTP service for generating, delivering, and verifying phone-number OTPs through a configured provider sequence. It uses TypeScript, Effect, PostgreSQL, and pg-boss. The service returns after durable state and queued work commit. Workers contact providers later, and uncertain delivery never triggers an automatic resend or fallback.

Start with [the running guide](docs/running.md). Real-provider configuration is documented in [provider setup](docs/provider-setup.md). The short local path is:

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
docker compose up --build -d --wait
```

Compose starts PostgreSQL and the combined HTTP API/worker at `http://127.0.0.1:3000`. pg-boss runs inside the router and stores its queue in PostgreSQL. `docker compose down` stops the stack and preserves the database volume. Keep the generated `.env` across restarts. See [Compose configuration](docs/running.md#docker-compose) for real providers, configuration mounts, and backend networking.

The deterministic example provider is local and does not send real messages. Use a designated test recipient and explicit authorization before testing a real provider. Do not put OTPs, credentials, full recipient numbers, context IDs, raw provider payloads, or authorization headers in logs.

Available checks are:

```sh
pnpm typecheck
pnpm build
pnpm lint
pnpm format:check
pnpm check
pnpm test
```

The container image runs `node dist/main.js --config /app/config/router.config.ts`. Mount one operator-supplied TypeScript entry file and provide secrets through the environment or a secret store. The image supports combined, API-only, and worker-only roles through configuration. It does not publish to a public registry.

Read the current contracts before changing behavior:

- [Product specification](docs/specifications.md)
- [Architecture](docs/architecture.md)
- [Routing and delivery](docs/routing.md)
- [API design](docs/api.md)
- [Verification and security](docs/security.md)
- [Provider and extension contracts](docs/plugins.md)
- [Data model](docs/data-model.md)
- [Deployment and operations](docs/operations.md)
- [Provider constraints](docs/provider-research.md)

[The validation record](docs/v1-validation.md) records tested versions, artifact digests, and reproducible checks. [The implementation plan](docs/development-plan.md) defines the phases. [The release checklist](docs/release-checklist.md) and [implementation evidence](docs/implementation-evidence.md) identify what still needs reproducible evidence. Provider-specific facts remain subject to the research record.

The package is private and licensed under [MIT](LICENSE). Copyright 2026 Alisher Isorilov.
