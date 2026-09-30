import type { RuntimeCommand, Policy } from "@otp-router/engine/runtime";

// Persist each exact command and its idempotency key before issuing it. This fixed
// sequence is intended for initial provisioning of a fresh database.
export const demoCommands = (
  callbackSecret: string,
  managed = true,
  instanceId = "fake-primary",
): readonly (typeof RuntimeCommand.Type)[] => {
  const settings: Policy = {
    providerInstanceIds: [instanceId],
    purposes: ["login"],
    external: true,
    ...(managed
      ? { managed: { codeLength: 6, lifetimeSeconds: 300, maxIncorrectGuesses: 5 } }
      : {}),
    maxLifetimeSeconds: 900,
    maxSends: 6,
    resendCooldownSeconds: 30,
    manualSelectionEnabled: false,
    manualProviderIds: [],
    fallback: "confirmed_failure",
    defaultLocale: "en",
    fallbackLocales: [],
  };
  return [
    {
      action: "create",
      id: "demo-provider",
      data: {
        kind: "account",
        adapterId: "deterministic-fake",
        schemaVersion: "1",
        identity: { account: "local-demo" },
        scopeIds: [],
      },
      firstInstance: {
        id: instanceId,
        settings: {
          label: "Local fake",
          execution: { outcome: "accepted" },
          templates: {},
          sendTimeoutMs: 1000,
        },
        scopeIds: [],
      },
    },
    {
      action: "rotate",
      kind: "account",
      id: "demo-provider",
      expectedRevision: 1,
      purpose: "send",
      secrets: {},
    },
    {
      action: "rotate",
      kind: "account",
      id: "demo-provider",
      expectedRevision: 2,
      purpose: "callback",
      secrets: { callbackSecret },
    },
    {
      action: "lifecycle",
      kind: "account",
      id: "demo-provider",
      expectedRevision: 3,
      state: "enabled",
    },
    {
      action: "lifecycle",
      kind: "instance",
      id: instanceId,
      expectedRevision: 1,
      state: "enabled",
    },
    { action: "grant", kind: "instance", id: instanceId, expectedRevision: 2, projectId: "demo" },
    { action: "create", id: "login", data: { kind: "policy", settings } },
    { action: "lifecycle", kind: "policy", id: "login", expectedRevision: 1, state: "enabled" },
    { action: "grant", kind: "policy", id: "login", expectedRevision: 2, projectId: "demo" },
  ];
};
