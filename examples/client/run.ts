import { randomUUID } from "node:crypto";
import { createClient } from "@otp-router/client";

const bearerToken = process.env["OTP_ROUTER_API_KEY"];
if (bearerToken === undefined) throw new Error("Set OTP_ROUTER_API_KEY");
const client = createClient({
  baseUrl: process.env["OTP_ROUTER_URL"] ?? "http://127.0.0.1:3000",
  projectId: "demo",
  bearerToken,
});
const input = {
  recipient: { type: "phone" as const, phoneNumber: "+998901234567" },
  purpose: "login",
  policyId: "login",
  contextId: randomUUID(),
};
// Persist this pair before sending in an application. Retry only this intended mutation with it.
const idempotencyKey = randomUUID();
const created = await client.createChallenge(input, { idempotencyKey });
const replay = await client.createChallenge(input, { idempotencyKey });
process.stdout.write(
  `Challenge ${created.data.challengeId}; same-key replay: ${String(replay.replayed)}\n`,
);
// The fake provider never delivers a usable code. End this demonstration without verification.
await client.cancelChallenge(created.data.challengeId, { idempotencyKey: randomUUID() });

// Your upstream authority owns generation, expiry and verification for external delivery.
const external = await client.createDelivery(
  {
    ...input,
    recipient: { type: "phone", phoneNumber: "+998901234568" },
    contextId: randomUUID(),
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
    code: "000123",
  },
  { idempotencyKey: randomUUID() },
);
await client.closeDelivery(external.data.operationId, { idempotencyKey: randomUUID() });
const history = await client.listEvents({ operationId: external.data.operationId });
process.stdout.write(
  `External operation ${external.data.operationId}; retained events: ${String(history.data.events.length)}\n`,
);
