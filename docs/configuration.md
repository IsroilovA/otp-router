# Configuration reference

The service loads a trusted TypeScript module with a default `defineConfig(...)` export. Start from the [fake example](../examples/config/router.config.ts) or [built-in providers](../examples/config/builtins.config.ts). The authoritative schemas are [Settings and Policy](../src/config/config.ts); this guide explains the main deployment choices.

Environment variables do not automatically override configuration fields. `DATABASE_URL` is read by the database and queue layers. The supplied entry files explicitly read the `OTP_ROUTER_*` and provider variables documented below; add other settings to the entry file itself.

## Environment and entry files

| Variable | Used by | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | All database-backed modes | PostgreSQL connection URL; Compose overrides it with its internal database address. |
| `OTP_ROUTER_WEBHOOK_URL`, `OTP_ROUTER_WEBHOOK_SIGNING_SECRET` | Both examples, optional | One outbound destination and an independent `whsec_`-prefixed base64 32-byte signing secret. Setting the URL requires the secret. |
| `OTP_ROUTER_API_KEY` | Both examples | Backend Bearer credential, at least 32 characters. |
| `OTP_ROUTER_ENCRYPTION_KEY`, `OTP_ROUTER_VERIFICATION_KEY`, `OTP_ROUTER_FINGERPRINT_KEY`, `OTP_ROUTER_RECIPIENT_KEY` | Both examples | Four independent, canonical base64url-encoded 32-byte keys. Preserve them across restarts. |
| `OTP_ROUTER_FAKE_CALLBACK_SECRET` | Fake example | Fake callback authentication secret. |
| `OTP_ROUTER_DEPLOYMENT_ID` | Built-in example | Stable identity for this deployment. The fake example hardcodes `local-demo`. |
| `OTP_ROUTER_HOST`, `OTP_ROUTER_INTERNAL_HOST` | Both examples | Listener addresses; default `127.0.0.1`. Compose overrides them for container networking. |
| `OTP_ROUTER_CONFIG_DIR`, `OTP_ROUTER_CONFIG_FILE` | Compose only | Host configuration directory and entry filename; defaults `./examples/config` and `router.config.ts`. |
| `OTP_ROUTER_ENV_FILE` | Compose only | Container secrets file; default `.env`. Pass `--env-file` too when using that file for Compose interpolation. |
| `OTP_ROUTER_PORT`, `OTP_ROUTER_POSTGRES_PORT` | Compose only | Published host ports; defaults 3000 and 54329. These do not change the process's listening ports. |

Provider credentials are listed in [provider setup](provider-setup.md). Node does not load `.env` automatically: use `node --env-file=.env ...` on the host. Compose supplies the environment itself.

Node loads TypeScript through its native type stripping. Keep entries compatible with that runtime and place them where their imports can resolve `otp-router`, `effect`, and any installed adapter packages. The Compose mount at `/app/config` does this for the standard image. The standard image contains only built-in adapters; install custom adapters into a deployment image before importing them.

## Settings

`settings` requires `crypto`, `apiKeys`, `defaultLocale`, `fallbackLocales`, `policies`, `purposes`, `deploymentSendLimit15m`, and `deploymentSendLimit24h`. The examples supply all of them. `purposes` maps each allowed purpose to its permitted policy IDs. `providers` registers provider layers; optional `selectors` maps policy IDs to [routing selectors](plugins.md#routing-selectors).

| Setting | Default | Meaning |
| --- | --- | --- |
| `role` | `combined` | `api` serves application requests and webhooks; `worker` processes deliveries, recovery, and cleanup; `combined` does both. Every role exposes health and metrics. |
| `host`, `port` | `127.0.0.1`, 3000 | Application listener; absent for worker-only processes. |
| `internalHost`, `internalPort` | `127.0.0.1`, 3001 | Private health and metrics listener. Give separate local processes different ports. |
| `workerConcurrency` | 4 | Worker concurrency setting, 1–64. |
| `shutdownGraceMs` | 30000 | Application shutdown allowance, 1000–120000 ms. |
| `selectorTimeoutMs` | 2000 | Complete selector deadline, 1–60000 ms. |
| `recipientCreateLimit15m` | 5 | Recipient-wide creations, 1–5 per rolling 15 minutes. |
| `recipientSendLimit15m`, `recipientGuessLimit15m` | 10 each | Recipient-wide sends and incorrect guesses, each 1–10 per rolling 15 minutes. |
| `deploymentSendLimit15m`, `deploymentSendLimit24h` | Required | Positive send caps across all recipients and providers. |
| `providerSendLimits15m` | `{}` | Optional positive send caps keyed by instance ID. |
| `providerLabels` | `{}` | Display labels saved at creation for accepted providers and manual choices, up to 128 characters each; defaults to channel. |
| `webhook` | Omitted | `{ url, signingSecret }` enables outbound notifications. HTTPS is required except HTTP on literal loopback hosts for local tests. No URL credentials, fragments, redirects, or extra Bearer token. |

`apiKeys` accepts one or two credentials; use two temporarily for rotation. Cryptographic key rings use `{ active: "v1", keys: { v1: "..." } }`. Follow [key rotation](security.md#key-rotation) when adding or removing keys.

## Policies

Each named policy requires a nonempty, ordered `providerInstanceIds` list with no duplicates. Purposes, policies, and instance IDs use 1–64 ASCII letters, digits, underscores, or hyphens.

| Policy field | Default | Bounds or behavior |
| --- | --- | --- |
| `codeLength` | 6 | 6–8 digits; provider constraints may narrow this. |
| `lifetimeSeconds` | 300 | 60–600 seconds, fixed at creation. |
| `maxIncorrectGuesses` | 5 | 1–5 across all delivery actions. |
| `maxSends` | 6 | 1–10, including automatic fallback and explicit sends. |
| `resendCooldownSeconds` | 30 | 30–300, strictly shorter than the lifetime. |
| `manualSelectionEnabled` | `false` | Allows caller choice of a provider or channel. |
| `manualProviderIds` | Omitted | Restricts manual selection to these policy providers; omission permits all policy providers when manual selection is enabled. |

All provider timeouts and minimum delivery windows must fit the policy lifetime. Configure templates for the default locale and chosen fallbacks before startup. Configuration is immutable while running; use the [drain procedure](operations.md#configuration-changes) for incompatible changes.

## Database identity

Startup binds an empty database to `crypto.deploymentId` and the recipient key. Later runs must use the same identity and retain keys needed by stored records. An empty challenge table does not reset the deployment identity.

Create a separate database for another application or for moving from the demo to production. Do not edit the identity row or delete volumes to bypass compatibility errors on data you need. For the same deployment, use the documented [restore and recipient-key procedures](operations.md#database-restore).

## CLI modes

All modes except `--openapi` require `--config /path/to/router.config.ts`. Use one mode per invocation.

| Mode | Effect |
| --- | --- |
| No mode flag | Validate, migrate, initialize, then serve the selected role. |
| `--check-config` | Load the entry and validate configuration and local provider/template setup, then exit; no core database connection or send. |
| `--check-schema` | Apply migrations, initialize database identity and queues, check compatibility, then exit; no HTTP listener or sends. |
| `--openapi` | Print generated OpenAPI JSON without loading configuration or connecting to PostgreSQL. |
| `--replay-webhook <eventId>` | Queue a retained failed notification again with its original event ID/body; never resend an OTP. |
| `--invalidate-restored` | Cancel restored active challenges; requires all traffic and workers stopped. |
| `--adopt-recipient-key` | Adopt a replacement recipient key only after the incident procedure succeeds. |

Configuration modules and custom providers are trusted executable code; their initialization can have side effects even during validation.
