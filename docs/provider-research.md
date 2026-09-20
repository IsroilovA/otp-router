# Provider protocol references

These references explain protocol constraints behind the adapters. Account configuration belongs in [provider setup](provider-setup.md); common outcome handling belongs in [routing](routing.md).

## Telegram Gateway

The API accepts E.164 numbers, caller-supplied numeric codes of four to eight digits, and delivery `ttl` of 30 to 3600 seconds. `checkSendAbility` can charge on success; its returned `request_id` permits one associated send without another fee. This is not general send idempotency. No caller-generated send idempotency key is documented.

Callbacks include `request_id`, optional caller `payload`, and status. Authentication uses HMAC-SHA256 with `SHA256(api_token)` as key and `timestamp + "\n" + raw_body` as input, supplied through `X-Request-Timestamp` and `X-Request-Signature`. Telegram retries failed acknowledgements up to ten times. The API's example `ACCESS_TOKEN_INVALID` does not establish a complete stable error taxonomy. [Gateway API](https://core.telegram.org/gateway/api).

## Meta WhatsApp Cloud API

Copy-code authentication templates accept codes up to fifteen characters and require the same code in the body and URL-button parameters. The optional `code_expiration_minutes` footer accepts 1 to 90 minutes; it displays a warning rather than enforcing validity. [Authentication templates](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates/copy-code-button-authentication-templates).

Template-level `message_send_ttl_seconds` accepts 30 to 900 seconds. The default is 600 seconds for templates created since October 23, 2024; older templates default to thirty days. Meta also permits `-1` for thirty days. The documented copy-code payload does not establish a per-send TTL override. [Message time-to-live](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/time-to-live).

The phone-number `messages` endpoint returns a `wamid` for correlation. This does not establish send idempotency. [Meta Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

Webhook setup verification uses a GET challenge and configured verify token. POST authentication separately validates `X-Hub-Signature-256` over raw bytes using the app secret. [Meta's official examples](https://github.com/fbsamples/whatsapp-api-examples).

## Play Mobile SMS

The HTTP API uses Basic authentication, recipient digits without `+`, and `sms.content.text`. Its recipient mask conflicts with its examples. `sms.ttl` is documented in seconds, but the table and examples differ on number versus string serialization.

HTTP 200 acknowledges acceptance. Error `100` is documented as an internal server error even under HTTP 400, so it does not prove rejection. The wiki specifies message IDs up to forty characters but provides no send-deduplication, callback-authentication, or polling contract. [Official HTTP API wiki](https://wiki.playmobile.uz/doku.php/ru/интеграция_с_сервисом_api/интеграция_по_http).

The older PDF limits message IDs to twenty characters and describes SMS encoding and segmentation. These conflicting ID limits justify using the shorter bound until the account confirms otherwise. [Official API PDF](https://playmobile.uz/wp-content/uploads/2022/08/http.pdf).
