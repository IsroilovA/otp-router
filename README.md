# OTP Router

A self-hosted OTP router. Applications use its HTTP server to route managed verification or externally generated codes through Telegram, WhatsApp, SMS, and custom providers, with project isolation, optional send authorization, shared provider limits and explicit handling of uncertain delivery.

Confirmed failures can advance the configured route. Uncertainty alone never triggers an automatic resend; an explicit user action can request another attempt. Resends preserve the original code and expiry. External-code callers retain responsibility for generation and verification.

Start with [local setup](docs/running.md). The examples use fake providers and send no messages. Use [provider setup](docs/provider-setup.md) for a real deployment.

## Contracts

- [Managed and external capabilities](docs/engine.md)
- [Routing](docs/routing.md), [verification and security](docs/security.md), and [consistency guarantees](docs/data-model.md)
- [HTTP integration](docs/api.md), [projects](docs/projects.md), and [outbound webhooks](docs/webhooks.md)
- [TypeScript client](docs/client.md), [releases](docs/releases.md), and [changelog](CHANGELOG.md)
- [Attempt history](docs/history.md) and [send authorization](docs/authorization.md)
- [Deployment configuration](docs/configuration.md), [runtime configuration](docs/runtime-configuration.md), and [provider extensions](docs/plugins.md)
- [Deployment and recovery](docs/operations.md)

Schemas define supported shapes; see [HTTP integration](docs/api.md) to generate the API reference.

## Development

Use the Node.js and pnpm versions declared in [package.json](package.json). Docker is required for PostgreSQL tests.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

`pnpm check` includes the build. See [AGENTS.md](AGENTS.md) for conventions.

The server is distributed as a container image and the backend TypeScript client as `@otp-router/client`. Publishing setup and the release process are described in the [release guide](docs/releases.md). Engine and server workspace packages remain private npm packages.

Licensed under [MIT](LICENSE). Copyright 2026 Alisher Isorilov.
