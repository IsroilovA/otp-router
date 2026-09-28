# HTTP walkthrough

Run the [local server](../../docs/running.md) first. These commands use its fake provider, which accepts sends but does not deliver a usable OTP. Use a private backend connection and keep the Bearer key, codes, and request bodies out of logs. The examples use two recipients so their admission cooldowns do not interfere.

Run this setup in the same shell as the requests:

```sh
BASE=http://127.0.0.1:3000
API_KEY=$(node --env-file=.env -p 'process.env.OTP_ROUTER_API_KEY')
new_key() { node -p 'require("node:crypto").randomUUID()'; }
```

## Managed verification

Create a challenge and retain the request key and exact body. The response contains `challengeId`; it does not contain the generated code.

```sh
MANAGED_KEY=$(new_key)
MANAGED_BODY='{"recipient":{"type":"phone","phoneNumber":"+998901234567"},"purpose":"login","contextId":"managed-demo-1","policyId":"login"}'
MANAGED_RESPONSE=$(curl -fsS -X POST "$BASE/v1/challenges" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $MANAGED_KEY" --data-binary "$MANAGED_BODY")
CHALLENGE_ID=$(node -p 'JSON.parse(process.argv[1]).challengeId' "$MANAGED_RESPONSE")
curl -fsS "$BASE/v1/challenges/$CHALLENGE_ID" -H "Authorization: Bearer $API_KEY"
```

If the create response is lost, retry the same body with `MANAGED_KEY`. A committed replay returns the original response and `Idempotency-Replayed: true`; recover its `challengeId` and read status afterward because that snapshot may be old. Use a fresh key only for a new intended mutation.

```sh
MANAGED_RESPONSE=$(curl -fsS -X POST "$BASE/v1/challenges" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $MANAGED_KEY" --data-binary "$MANAGED_BODY")
CHALLENGE_ID=$(node -p 'JSON.parse(process.argv[1]).challengeId' "$MANAGED_RESPONSE")
curl -fsS "$BASE/v1/challenges/$CHALLENGE_ID" -H "Authorization: Bearer $API_KEY"
```

A resend queues another attempt with the original code and deadline. Request it when `actions.resend.allowed` is true, or reconsider a timed cooldown denial after `actions.resend.availableAt` passes. [Action forecasts](../../docs/api.md#status-and-action-forecasts) do not refresh merely as time passes; the server revalidates every command. The local fake route has no next provider.

```sh
MANAGED_SEND_KEY=$(new_key)
curl -fsS -X POST "$BASE/v1/challenges/$CHALLENGE_ID/deliveries" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $MANAGED_SEND_KEY" --data-binary '{"action":"resend"}'
```

For a multi-provider route, the same deliveries endpoint accepts `{"action":"next"}`. When manual selection is enabled, use `{"action":"select","choice":{"type":"provider","providerInstanceId":"sms-main"}}` with an instance allowed by that policy. Each choice needs its own request key; wait for cooldown and check its action forecast. These choices also apply to external operations.

With a real provider and a code received by the authorized user, submit the code as a **string** to preserve leading zeros. The local fake provider cannot supply a real code for this step. A successful result must be consumed once by the calling backend; receiving or delivering a message is not verification.

```sh
printf 'Received code: '
read -rs RECEIVED_CODE
printf '\n'
VERIFY_KEY=$(new_key)
printf '{"code":"%s","purpose":"login","contextId":"managed-demo-1"}' "$RECEIVED_CODE" | \
  curl -fsS -X POST "$BASE/v1/challenges/$CHALLENGE_ID/verify" \
    -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $VERIFY_KEY" --data-binary @-
unset RECEIVED_CODE
```

## External code delivery

The upstream backend generates and verifies its own code. Supply a fixed deadline within the configured policy limit, and retain the code as a string. This one-step create attaches the code and queues initial delivery; the fake provider still sends no message.

```sh
EXTERNAL_DEADLINE=$(node -p 'new Date(Date.now() + 300000).toISOString()')
printf 'External code (6–8 digits): '
read -rs EXTERNAL_CODE
printf '\n'
EXTERNAL_KEY=$(new_key)
EXTERNAL_RESPONSE=$(printf '{"recipient":{"type":"phone","phoneNumber":"+998901234568"},"purpose":"login","contextId":"external-demo-1","policyId":"login","expiresAt":"%s","code":"%s"}' "$EXTERNAL_DEADLINE" "$EXTERNAL_CODE" | \
  curl -fsS -X POST "$BASE/v1/delivery-operations/with-code" \
    -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $EXTERNAL_KEY" --data-binary @-)
# Keep the upstream code and this deadline available until an ambiguous create is reconciled.
OPERATION_ID=$(node -p 'JSON.parse(process.argv[1]).operationId' "$EXTERNAL_RESPONSE")
curl -fsS "$BASE/v1/delivery-operations/$OPERATION_ID" -H "Authorization: Bearer $API_KEY"
```

Using the same action-forecast timing rules as above, resend the **same attached code**. Close the operation when its upstream flow ends, even if delivery remains uncertain. Closing cannot recall an in-flight message and does not verify the code.

```sh
EXTERNAL_SEND_KEY=$(new_key)
curl -fsS -X POST "$BASE/v1/delivery-operations/$OPERATION_ID/deliveries" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $EXTERNAL_SEND_KEY" --data-binary '{"action":"resend"}'
EXTERNAL_CLOSE_KEY=$(new_key)
curl -fsS -X POST "$BASE/v1/delivery-operations/$OPERATION_ID/close" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $EXTERNAL_CLOSE_KEY" --data-binary '{}'
unset EXTERNAL_CODE
```

For other action choices and error shapes, generate the [OpenAPI reference](../../docs/api.md). Keep each mutation's key and exact body for retries after an ambiguous response.
