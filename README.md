# OTP Router

A private, self-hosted HTTP service for generating, delivering, and verifying phone-number OTPs. Applications configure an ordered route through Telegram, WhatsApp, SMS, or custom providers.

Creation commits the challenge and queued work before returning. Workers send afterward. Confirmed failures can advance the route; uncertain delivery waits for an explicit user action. Resends reuse the code and original expiry.

Start with the [running guide](docs/running.md) and [provider setup](docs/provider-setup.md). The local example uses a fake provider and sends no messages.

## Documentation

- [Architecture](docs/architecture.md) and [transaction design](docs/data-model.md)
- [Routing](docs/routing.md) and [verification security](docs/security.md)
- [HTTP integration](docs/api.md)
- [Provider and selector extensions](docs/plugins.md)
- [Deployment and operations](docs/operations.md)

Source schemas define configuration and wire formats. Generate OpenAPI with `node dist/main.js --openapi` after building; never edit its output manually. Historical experiments are in the [research archive](docs/research/README.md).

## Development

Use the pinned pnpm version in `package.json`. Docker is required for PostgreSQL integration tests.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm exec vitest run tests/integration.test.ts
```

Tests own disposable databases and fake providers. Real sends require explicit authorization and a designated recipient. Follow [AGENTS.md](AGENTS.md) for development rules.

Distribution remains private. Licensed under [MIT](LICENSE). Copyright 2026 Alisher Isorilov.
