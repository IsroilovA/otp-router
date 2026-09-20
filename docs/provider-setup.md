# Built-in provider setup

The [built-in configuration example](../examples/config/builtins.config.ts) registers Telegram Gateway, direct Meta WhatsApp Cloud API, and Play Mobile in that order. It uses the same cryptographic keys and API key as the [running guide](running.md), plus `OTP_ROUTER_DEPLOYMENT_ID` and the provider variables below. Choose deployment send caps for your account budgets before enabling traffic. The example caps are 100 sends per 15 minutes and 1,000 per day, across all recipients and providers.

Copy the example into your deployment and remove providers you do not use from both registration and policy order. Instance IDs identify accounts. Use a new ID for a different account. Change `settingsFingerprint` when non-secret delivery settings change and follow the [drain procedure](operations.md#configuration-changes). Keep credentials outside the image.

| Provider | Required environment | Operator setup |
| --- | --- | --- |
| Telegram Gateway | `TELEGRAM_GATEWAY_TOKEN`, `TELEGRAM_CALLBACK_URL` | Obtain and fund a Gateway account. Point the HTTPS callback URL at `/webhooks/telegram-main`. The adapter sends the router's code directly and authenticates callback bytes with the token-derived signature. |
| Meta WhatsApp | `META_ACCESS_TOKEN`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_PHONE_NUMBER_ID`, `META_API_VERSION`, `META_AUTHENTICATION_TEMPLATE` | Register the business phone number and approve an authentication template with a copy-code button. The example expects language `en_US` and button index 0. Subscribe the app to the account and use `/webhooks/whatsapp-main` for both verification handshake and signed status reports. Set an explicitly supported Graph API version for your account. |
| Play Mobile | `PLAY_MOBILE_USERNAME`, `PLAY_MOBILE_PASSWORD`, `PLAY_MOBILE_ORIGINATOR` | Obtain API credentials, an approved sender, and confirmation of permitted destinations and TTL bounds. The example uses the documented broker endpoint and one English SMS segment. Incoming receipts are disabled because the available account-independent documentation does not establish their authentication contract. |

These instructions implement the contracts recorded in [provider research](provider-research.md). Account approval, API versions, remote templates, and live delivery remain operator checks. The adapter tests use deterministic transports and do not establish account access.

After supplying the variables, validate locally without sending:

```sh
pnpm build
node --env-file=.env dist/main.js --check-config --config "$PWD/examples/config/builtins.config.ts"
node --env-file=.env dist/main.js --check-schema --config "$PWD/examples/config/builtins.config.ts"
```

The first command after the build validates configuration and template structure without contacting providers. Schema checking contacts PostgreSQL and runs startup migrations. Neither command sends a message. Starting the service enables sends when authenticated clients create challenges, so use the fake configuration until real sends have been explicitly authorized.

All three adapters default to a 10,000 ms send timeout. An instance can set `sendTimeoutMs` in its `make` options. The core enforces the complete-operation deadline and preserves uncertainty when it expires. The value is a local default, not a measured provider latency guarantee. Telegram and Play Mobile derive TTL from the remaining database-time budget, less request timeout and elapsed local time. Meta does not claim per-send TTL enforcement.

Set Meta's `message_send_ttl_seconds` on the approved authentication template. Its supported short delivery window is 30 to 900 seconds, with a default of 600 seconds for templates created since October 23, 2024. Older templates default to thirty days. Choose a short window no greater than the configured challenge lifetime. The adapter does not create or update remote templates. A template-level TTL cannot track the shorter remaining lifetime on resend, so delivery after challenge expiry remains possible; the router rejects verification after the original deadline. [Meta TTL documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/time-to-live).

Keep authentication templates free of fixed relative validity claims. Resend uses the original expiry, so "valid for five minutes" would become inaccurate. The example SMS contains only the code. Add locale entries to each provider's templates and change the global fallback order as needed; the core saves each provider's resolved template at creation.

Before enabling real traffic, authorize a smoke test with a designated recipient. Check acceptance, receipt correlation where supported, resend, and verification using the account's configured API version and templates.
