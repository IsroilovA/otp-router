# OTP Router

A private, unreleased self-hosted OTP router. Applications use its HTTP server to route managed verification or externally generated codes through Telegram, WhatsApp, SMS, and custom providers, with project isolation, optional send authorization, shared provider limits and explicit handling of uncertain delivery.

Confirmed failures can advance the configured route. Uncertainty alone never triggers an automatic resend; an explicit user action can request another attempt. Resends preserve the original code and expiry. External-code callers retain responsibility for generation and verification.

Start with [local setup](docs/running.md). The examples use fake providers and send no messages. Use [provider setup](docs/provider-setup.md) for a real deployment.

## Contracts

- [Managed and external capabilities](docs/engine.md)
- [Routing](docs/routing.md), [verification and security](docs/security.md), and [consistency guarantees](docs/data-model.md)
- [HTTP integration](docs/api.md), [projects](docs/projects.md), and [outbound webhooks](docs/webhooks.md)
- [Attempt history](docs/history.md) and [send authorization](docs/authorization.md)
- [Configuration choices](docs/configuration.md) and [provider extensions](docs/plugins.md)
- [Deployment and recovery](docs/operations.md)

Schemas and exported TypeScript contracts define supported shapes. Generate the HTTP reference with `node apps/server/dist/main.js --openapi` after building; never edit generated output.

## Development

Use the Node.js and pnpm versions declared in [package.json](package.json). Docker is required for PostgreSQL tests.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

`pnpm check` builds before checking; `pnpm build` also runs independently. Consumers resolve built engine exports. See [AGENTS.md](AGENTS.md) for conventions.

Distribution remains private. Licensed under [MIT](LICENSE). Copyright 2026 Alisher Isorilov.
