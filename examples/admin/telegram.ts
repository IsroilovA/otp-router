import { createAdminClient, type RuntimeCommandDto } from "@otp-router/client";

const required = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Set ${name}`);
  return value;
};
const administrator = createAdminClient({
  baseUrl: process.env["OTP_ROUTER_URL"] ?? "http://127.0.0.1:3000",
  bearerToken: required("OTP_ROUTER_ADMIN_KEY"),
});
const token = required("OTP_ROUTER_TELEGRAM_TOKEN");
const account = "demo-telegram";
const instance = "demo-telegram-sender";
const policy = "demo-telegram-login";
const commands: readonly RuntimeCommandDto[] = [
  {
    action: "create",
    id: "demo-telegram-allowance",
    data: { kind: "scope", limits: { sendLimit15m: 10, sendLimit24h: 100 } },
  },
  {
    action: "create",
    id: account,
    data: {
      kind: "account",
      adapterId: "telegram-gateway",
      schemaVersion: "1",
      identity: { account: required("OTP_ROUTER_TELEGRAM_ACCOUNT_ID") },
      scopeIds: ["demo-telegram-allowance"],
    },
    firstInstance: {
      id: instance,
      scopeIds: [],
      settings: {
        label: "Telegram",
        execution: {
          deliveryTtlSeconds: 60,
          callbackUrl: required("OTP_ROUTER_TELEGRAM_CALLBACK_URL"),
        },
        templates: {},
        sendTimeoutMs: 10000,
      },
    },
  },
  {
    action: "rotate",
    kind: "account",
    id: account,
    expectedRevision: 1,
    purpose: "send",
    secrets: { apiToken: token },
  },
  {
    action: "rotate",
    kind: "account",
    id: account,
    expectedRevision: 2,
    purpose: "callback",
    secrets: { apiToken: token },
  },
  { action: "lifecycle", kind: "account", id: account, expectedRevision: 3, state: "enabled" },
  { action: "lifecycle", kind: "instance", id: instance, expectedRevision: 1, state: "enabled" },
  { action: "grant", kind: "instance", id: instance, expectedRevision: 2, projectId: "demo" },
  {
    action: "create",
    id: policy,
    data: {
      kind: "policy",
      settings: {
        providerInstanceIds: [instance],
        purposes: ["login"],
        external: true,
        managed: { codeLength: 6, lifetimeSeconds: 300, maxIncorrectGuesses: 5 },
        maxLifetimeSeconds: 300,
        maxSends: 3,
        resendCooldownSeconds: 60,
        manualSelectionEnabled: false,
        manualProviderIds: [],
        fallback: "disabled",
        defaultLocale: "en",
        fallbackLocales: [],
      },
    },
  },
  { action: "lifecycle", kind: "policy", id: policy, expectedRevision: 1, state: "enabled" },
  { action: "grant", kind: "policy", id: policy, expectedRevision: 2, projectId: "demo" },
];
await administrator.createProject(
  {
    id: "demo",
    settings: { authorizationRequired: false, sendLimit15m: 100, sendLimit24h: 1000 },
    principalIds: ["backend"],
  },
  { idempotencyKey: "provision-demo-v1" },
);
// These stable keys are for initial provisioning. Persist the exact command/key
// pair for retries; use a new key and current revision for subsequent edits.
for (const [index, command] of commands.entries())
  await administrator.mutateRuntime(command, { idempotencyKey: `provision-telegram-v1-${index}` });
process.stdout.write(`Provisioned policy ${policy}. No messages sent.\n`);
