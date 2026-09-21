# OTP Router

A private, unreleased engine for managed phone OTP challenges and delivery of externally generated, externally verified codes, with a self-hosted HTTP server. Applications configure an ordered route through Telegram, WhatsApp, SMS, or custom providers. Expect breaking configuration and schema changes while development continues.

Managed creation atomically composes a challenge with an independent delivery operation. External callers can prepare a fixed-deadline operation, attach a code once, resend/select, and close. Submission commits snapshots, events and queued work before returning. Workers send afterward. Confirmed failures can advance the route; uncertain delivery waits for an explicit user action. Resends reuse the code and original expiry.

Start with the [running guide](docs/running.md) and [provider setup](docs/provider-setup.md). The local examples use fake providers and send no messages. See the [standalone external-code example](examples/external-code/README.md).

## Documentation

- [Engine package API](docs/engine.md)
- [Architecture](docs/architecture.md) and [transaction design](docs/data-model.md)
- [Routing](docs/routing.md) and [verification security](docs/security.md)
- [HTTP integration](docs/api.md) and [outbound webhooks](docs/webhooks.md)
- [Configuration reference](docs/configuration.md)
- [Provider and selector extensions](docs/plugins.md)
- [Deployment and operations](docs/operations.md)

Source schemas define configuration and wire formats. Generate OpenAPI with `node apps/server/dist/main.js --openapi` after building; never edit its output manually. Historical experiments are in the [research archive](docs/research/README.md).

## Development

The workspace contains `packages/engine` (`@otp-router/engine`), `apps/server` (`@otp-router/server`), and a custom-adapter consumer example. One lockfile pins every dependency. Server and examples import built package exports; build before running focused tests.

Use the pinned pnpm version in `package.json`. Docker is required for PostgreSQL integration tests.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
```

Tests own disposable databases and fake providers. For a focused run, use `pnpm exec vitest run tests/integration.test.ts`. Real sends require explicit authorization and a designated recipient. Follow [AGENTS.md](AGENTS.md) for development rules.

Distribution remains private. Licensed under [MIT](LICENSE). Copyright 2026 Alisher Isorilov.
