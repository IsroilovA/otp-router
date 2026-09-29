# Provider setup

Copy the [built-in configuration](../examples/config/builtins.config.ts), remove unused providers from registration and policy order, and set send caps for your account budgets. The entry owns credential-variable names and local settings. Use a separate production database, deployment identity, and secrets; follow [configuration changes](operations.md#configuration-changes) when replacing accounts or incompatible settings.

| Provider | Required account setup |
| --- | --- |
| Telegram Gateway | Fund a Gateway account and configure an HTTPS callback to the registered instance's webhook path. See the [Gateway API](https://core.telegram.org/gateway/api). |
| Meta WhatsApp | Register a business phone number, approve a copy-code authentication template for the configured locale/button, and select a supported Graph API version. Subscribe the app to the account and configure both verification handshake and signed status reports. See [authentication templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/copy-code-button-authentication-templates). |
| Play Mobile | Obtain API credentials, an approved sender, and confirmation of destinations, TTL bounds, and SMS segmentation. Incoming receipts remain disabled until an authenticated account contract is established. See the [HTTP API](https://wiki.playmobile.uz/doku.php/ru/интеграция_с_сервисом_api/интеграция_по_http). |

Keep secrets outside the image. Local adapter checks do not prove account access, remote template approval, or live delivery.

## Validate before enabling traffic

```sh
pnpm build
node --env-file=.env apps/server/dist/main.js --check-config --config "$PWD/examples/config/builtins.config.ts"
node --env-file=.env apps/server/dist/main.js --check-schema --config "$PWD/examples/config/builtins.config.ts"
```

Configuration checking contacts no provider. Schema checking changes PostgreSQL. Neither sends messages; starting the service enables sends on authorized requests. Real-send verification requires explicit authorization and designated recipients.

## Delivery constraints

Provider acceptance and request IDs do not establish delivery or send deduplication. Keep [uncertainty handling](routing.md) conservative even when a provider returns an error.

Telegram Gateway permits a [delivery TTL of 30–3600 seconds](https://core.telegram.org/gateway/api#sendverificationmessage). Set the cap to fit the policy lifetime, allowing for the request timeout. The router shortens TTL to the remaining delivery budget and rejects sends below the provider minimum.

Telegram reachability failures do not globally invalidate a phone number. An unsuccessful API request can permit fallback, but timeouts, server errors, malformed replies, and an already-sent response remain uncertain.

Keep Meta's signed [status callbacks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status) subscribed and reachable. Echoed attempt references allow reconciliation after a lost send response. Without that reference, correlation requires a previously recorded provider message ID. Inbound WhatsApp messages are acknowledged but are not delivery evidence. See the [callback contract](plugins.md#providers).

Set Meta's authentication-template TTL no longer than the intended code lifetime and inspect existing templates explicitly. Template TTL cannot follow the shorter remaining lifetime on resend; a displayed expiry warning does not enforce validity. See Meta's [message TTL contract](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/time-to-live).

Confirm Play Mobile's account limits before deployment, including support for the adapter's 20-character message IDs. Provider TTL never extends the router's verification deadline.
