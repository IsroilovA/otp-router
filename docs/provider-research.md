# Provider integration constraints

Checked 2026-09-20 against provider-owned documentation. No provider calls were made. Verified facts and unresolved account requirements are separated below. This document owns provider-specific constraints; [routing](routing.md) owns the response to normalized outcomes.

## Shared rules

The router generates and verifies one code against one deadline under D059. Provider delivery TTL controls how long the provider tries to deliver. It cannot extend verification. Adapters receive the original deadline and must not silently change the code.

A successful send response means acceptance. A missing response or missing provider ID does not prove rejection. Unique correlation IDs are not idempotency guarantees. Keep unknown capabilities disabled and do not infer messaging-account membership from delivery failures.

## Telegram Gateway

The official API accepts E.164 phone numbers and caller-supplied numeric codes of four to eight digits. Delivery `ttl` accepts 30 to 3600 seconds. Skip dispatch when its minimum cannot fit the remaining delivery budget.

Use direct sending. `checkSendAbility` can charge on success; its returned `request_id` permits one associated send without another fee. This is not general send idempotency. No caller-generated send idempotency key is documented.

Callbacks include `request_id`, optional caller `payload`, and status. Authenticate the raw body with HMAC-SHA256 using `SHA256(api_token)` as key and `timestamp + "\n" + raw_body` as input. Validate `X-Request-Timestamp` and compare `X-Request-Signature`. Persist an opaque delivery reference in `payload` before dispatch. Acknowledge with HTTP 200 after durable ingestion; Telegram retries failures up to ten times.

Map `sent` to accepted and `delivered` or `read` to delivered. Map authenticated `expired` to final delivery failure. Treat `revoked` according to the originating cancellation, not as permission to restart a cancelled challenge. Status lookup exists, but automatic provider polling is deferred under D090. [Gateway API](https://core.telegram.org/gateway/api).

Onboarding requires a Gateway account, token, and funding. An optional sender channel must meet Telegram's ownership and verification requirements. [Gateway tutorial](https://core.telegram.org/gateway/verification-tutorial).

Still required: test the adapter's exact error allowlist, callback replay tolerance, and TTL calculation. The API's example `ACCESS_TOKEN_INVALID` does not establish a complete stable error taxonomy. Unknown errors remain uncertain unless their documented meaning proves rejection.

## Meta WhatsApp Cloud API

Use approved authentication templates with the router's code. Meta's examples include copy-code and one-tap buttons and an optional `code_expiration_minutes` footer. The example value does not establish the current allowed range. [Meta authentication-template example](https://www.postman.com/meta/whatsapp-business-platform/documentation/3kru5r6/moved-whatsapp-business-management-api?entity=request-13382743-ec0a6c79-4ada-4e4b-920e-9ca00b0944a3).

Under D078, omit an optional relative-expiry footer unless it remains accurate on resend. A fixed five-minute message sent near the original deadline would misstate validity. Keep the actual expiry in application status. Adapter-specific templates and explicit locale fallback follow [the template contract](plugins.md#templates-and-localization); this does not settle unverified provider API constraints.

The operator supplies a business portfolio, WhatsApp Business Account, registered business phone number, and authorized access token. Subscribe the app to the account for webhooks. Send through the phone-number `messages` endpoint and persist its returned `wamid` as the provider reference. [Meta Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

Webhook setup verification and POST authentication are separate. The GET challenge uses the configured verify token; validate POST `X-Hub-Signature-256` over the raw body using the app secret. A setup verify token alone does not authenticate delivery reports. [Meta's official examples](https://github.com/fbsamples/whatsapp-api-examples).

Still unresolved: current caller-code limits, `message_send_ttl_seconds` limits and whether it can vary per send, template eligibility, a stable error mapping, callback retry horizons, and the current `biz_opaque_callback_data` contract. The current [authentication-template page](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/authentication-templates) and [error reference](https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes) could not be retrieved in this research pass. Do not substitute Twilio behavior or third-party TTL ranges. General send idempotency remains unavailable until verified.

## Play Mobile SMS

Use HTTPS with Basic authentication and one recipient per request. Put the router's code in `sms.content.text`. Convert core E.164 to provider digits without `+`. The wiki's recipient mask conflicts with its examples, so do not hard-code its `9989` prefix mask. Destination ranges need account confirmation.

The API documents `sms.ttl` in seconds. Its table says number while examples sometimes use strings; verify serialization and bounds with the account. Do not use scheduled-message or local-time fields for OTP delivery.

HTTP 200 acknowledges acceptance. Receipts contain caller `message-id`, status, and status time. Map authenticated `Delivered` to delivered; `Transmitted` remains accepted; `NotDelivered`, `Rejected`, `Failed`, and `Expired` are final failures. Normalize allowlisted diagnostic codes and discard free-text descriptions. Error `100` is documented as an internal server error even under HTTP 400, so it does not prove definitive rejection or authorize fallback. Automatic provider-send retries are prohibited under D069.

The wiki specifies message IDs up to forty characters but provides no send-deduplication, callback-authentication, or polling contract. [Official HTTP API wiki](https://wiki.playmobile.uz/doku.php/ru/интеграция_с_сервисом_api/интеграция_по_http).

The older PDF limits message IDs to twenty characters. Use generated IDs within that limit until the account confirms otherwise. The PDF also describes SMS encoding and segmentation. Validate the complete rendered message using GSM-7 septets or Unicode encoding, not character count alone. [Official API PDF](https://playmobile.uz/wp-content/uploads/2022/08/http.pdf).

Start with configured SMS text templates. Provider-managed template IDs are optional and need their own verified contract. Prefer a single SMS segment for the default example; send-count caps are not monetary caps.

Before production: confirm authorized sender and destination ranges, TTL bounds and serialization, exact rejection codes, and test access. Keep receipt ingestion disabled until callback authentication is verified. Keep provider idempotency unavailable unless documented. Automatic status polling is deferred under D090 regardless of provider support. Sending can operate without receipts under the uncertain-delivery policy.

## Remaining provider evidence

The 2026-09-20 recheck used Telegram, Play Mobile, and Meta-owned Postman documentation. Meta's template reference remained inaccessible. No live calls or timing measurements were made.

| Provider | Evidence needed before claiming the integration complete | Safe behavior until verified |
| --- | --- | --- |
| Telegram | Fixtures and live tests for code/TTL boundaries, callback timestamp tolerance and retries, caller-reference correlation, rejection allowlist, and adapter timeout default. | Direct send only; unknown failures uncertain; no paid preflight, polling, or automatic retry. |
| Meta | Approved copy-code template matching the adapter schema; current code constraints, TTL location and range, correlation support, status/error mapping, callback behavior, and adapter timeout default. | Never infer per-send TTL support from a template-creation field; do not invent a provider idempotency guarantee. Unverified options are disabled and block a production-ready adapter claim when required for correct sending. |
| Play Mobile | Account-confirmed sender/destinations, TTL serialization/bounds, error allowlist, message-ID limit, SMS encoding, callback authentication if offered, and adapter timeout default. | Short IDs, one recipient per send, no receipt ingestion without authentication, no polling, and no send retry. |

Live tests require configured accounts and a designated recipient. Core implementation may proceed; adapters need this evidence before a production-ready claim.
