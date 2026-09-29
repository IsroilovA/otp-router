import { createAdminClient } from "@otp-router/client";

const bearerToken = process.env["OTP_ROUTER_ADMIN_KEY"];
if (bearerToken === undefined) throw new Error("Set OTP_ROUTER_ADMIN_KEY");
const administrator = createAdminClient({
  baseUrl: process.env["OTP_ROUTER_URL"] ?? "http://127.0.0.1:3000",
  bearerToken,
});
const input = {
  id: "demo",
  settings: {
    authorizationRequired: process.env["OTP_ROUTER_PROJECT_AUTHORIZATION"] === "required",
    sendLimit15m: 100,
    sendLimit24h: 1000,
  },
  principalIds: ["backend"],
};
// A stable key permits rerunning this provisioning example after a lost response.
// Real callers persist the exact input and key for each intended administrative action.
const created = await administrator.createProject(input, { idempotencyKey: "provision-demo-v1" });
const current = await administrator.getProject(input.id);
process.stdout.write(
  `Project ${current.data.id}: ${current.data.state}, ETag ${current.etag}; creation replayed: ${created.replayed}\n`,
);
// Settings/lifecycle/grant changes require a fresh key and this current ETag.
// Retrying such a change requires its original key, payload and original ETag.
const audit = await administrator.listAudit(input.id);
process.stdout.write(`Retained administrative events: ${audit.data.events.length}\n`);
