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

Telegram Gateway permits a delivery TTL of 30–3600 seconds. Configure the desired cap; each send uses the shorter of that cap and the remaining delivery budget after reserving time for the provider request, and a send with too little time is rejected locally. The [Gateway API](https://core.telegram.org/gateway/api) defines `ok: false` as an unsuccessful request, and its [sending tutorial](https://core.telegram.org/gateway/verification-tutorial#sending-auth-codes) explicitly includes recipients who cannot receive codes. A valid error envelope on HTTP 2xx or 4xx (except timeout 408) permits fallback even when its error name is unfamiliar. This relies on the documented API rejection contract, not an exhaustive error-name list. HTTP 5xx, timeouts, malformed replies, and `MESSAGE_ALREADY_SENT` remain uncertain and never authorize automatic fallback.

Gateway SDKs [list recipient-unavailable and already-sent names](https://github.com/apifonica/tg-gateway-go/blob/main/errors.go); these are community-maintained observations rather than an official exhaustive catalogue. Telegram reachability errors do not globally invalidate a phone number. Unclassified API rejections use `unspecified` as their reason and a fixed safe diagnostic; raw provider error text is never persisted.

Meta's [Cloud API messages](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages/) can include `biz_opaque_callback_data`, which [status webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status) can echo as the attempt reference. Keep signed status callbacks subscribed and reachable: that reference lets the router reconcile delivery even when the send response containing Meta's message ID is lost. If a report lacks the echoed reference, the message ID can still correlate it after a successful send response has been recorded. See the [provider callback contract](plugins.md#providers) for authentication and correlation rules.

Set Meta's authentication-template TTL no longer than the intended code lifetime and inspect existing templates explicitly. Template TTL cannot follow the shorter remaining lifetime on resend; a displayed expiry warning does not enforce validity. See Meta's [message TTL contract](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/time-to-live).

Confirm Play Mobile's message-ID limit for the account: the [older API PDF](https://playmobile.uz/wp-content/uploads/2022/08/http.pdf) and HTTP wiki disagree. Use the stricter documented bound until confirmed. Provider TTL never replaces the router's verification deadline.
