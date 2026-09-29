# OTP Router client

A typed Promise client for the self-hosted [OTP Router](https://github.com/IsroilovA/otp-router) HTTP API. Requires Node.js 24 or newer. ESM only. Pin the version and review [release compatibility and upgrade notes](https://github.com/IsroilovA/otp-router/blob/main/docs/releases.md) before upgrading.

```sh
npm install --save-exact @otp-router/client@0.0.1
```

```ts
import { randomUUID } from "node:crypto";
import { createClient, OtpRouterApiError } from "@otp-router/client";

const bearerToken = process.env.OTP_ROUTER_API_KEY;
if (bearerToken === undefined) throw new Error("Set OTP_ROUTER_API_KEY");
const client = createClient({
  baseUrl: "https://router.example",
  projectId: "demo",
  bearerToken,
});

const input = {
  recipient: { type: "phone" as const, phoneNumber: "+998901234567" },
  purpose: "login",
  contextId: "authorized-session-id",
  policyId: "login",
};
const idempotencyKey = randomUUID(); // Persist this key with the input before sending.
const result = await client.createChallenge(input, { idempotencyKey });
// result.data is validated. result.status and result.replayed describe the HTTP response.
const current = await client.getChallenge(result.data.challengeId);
```

Run this only on a trusted backend. Keep credentials and codes out of client applications and logs. Creation acknowledges durable work; provider acceptance does not verify a person.

The client supports managed challenges, external-code delivery, and history. Exported TypeScript declarations define methods and DTO fields.

Requests and responses are validated at runtime. Results include response data and HTTP metadata; unavailable header metadata is `null`.

Every mutation requires an explicit `idempotencyKey`. There are no automatic retries. After an ambiguous failure, retain the original payload/key and reconcile or retry with that same pair according to the [HTTP contract](https://github.com/IsroilovA/otp-router/blob/main/docs/api.md#idempotency). Replays can contain older snapshots.

`OtpRouterApiError` contains a validated error and HTTP metadata. Branch on `error.code`, not messages:

```ts
try {
  await client.verifyChallenge(current.data.challengeId, {
    code: "000123", purpose: "login", contextId: "authorized-session-id",
  }, { idempotencyKey: randomUUID() });
} catch (error: unknown) {
  if (error instanceof OtpRouterApiError && error.error.code === "incorrect_code") {
    const locked = error.error.reason === "locked";
    // Update your flow; a locked challenge cannot accept more guesses.
  } else {
    throw error;
  }
}
```

`OtpRouterClientError` distinguishes configuration, invalid requests, invalid responses, transport failures, timeout, caller abort, and unexpected defects through `kind` and its `error` DTO. Raw bodies, credentials, and underlying network errors are not attached. A transport failure or timeout does not establish that a mutation failed on the server.

The default deadline is 30 seconds for the complete request/response. Set `timeoutMs` on the client or per request in positive integer milliseconds. Pass an `AbortSignal` to cancel; an already-aborted signal prevents the request. Cancellation does not undo server work. Base URLs may include a reverse-proxy path prefix; redirects are rejected. Supply `fetch` to use a custom transport.

See the [client integration guide](https://github.com/IsroilovA/otp-router/blob/main/docs/client.md), [HTTP contract](https://github.com/IsroilovA/otp-router/blob/main/docs/api.md), and [history contract](https://github.com/IsroilovA/otp-router/blob/main/docs/history.md).
