import { createAdminClient } from "@otp-router/client";
import type { RuntimeCommandDto } from "@otp-router/client";

export const provisionHttp = async (port: number, mode: "process" | "benchmark") => {
  const client = createAdminClient({
    baseUrl: `http://127.0.0.1:${port}`,
    bearerToken: "admin-test-credential-with-at-least-32-bytes",
  });
  const id = `${mode}-fake`;
  const policyId = mode === "process" ? "default" : "benchmark";
  const commands: readonly RuntimeCommandDto[] = [
    {
      action: "create",
      id,
      data: {
        kind: "account",
        adapterId: `${mode}-test-fake`,
        schemaVersion: "1",
        identity: {},
        scopeIds: [],
      },
      firstInstance: {
        id,
        scopeIds: [],
        settings: {
          label: "Fake",
          execution: {},
          templates: {},
          sendTimeoutMs: mode === "process" ? 60000 : 1000,
        },
      },
    },
    { action: "rotate", kind: "account", id, expectedRevision: 1, purpose: "send", secrets: {} },
    { action: "lifecycle", kind: "account", id, expectedRevision: 2, state: "enabled" },
    { action: "lifecycle", kind: "instance", id, expectedRevision: 1, state: "enabled" },
    { action: "grant", kind: "instance", id, expectedRevision: 2, projectId: "demo" },
    {
      action: "create",
      id: policyId,
      data: {
        kind: "policy",
        settings: {
          providerInstanceIds: [id],
          purposes: [mode === "process" ? "login" : "benchmark"],
          external: true,
          managed: {
            codeLength: 6,
            lifetimeSeconds: mode === "process" ? 300 : 600,
            maxIncorrectGuesses: 5,
          },
          maxLifetimeSeconds: 900,
          maxSends: 10,
          resendCooldownSeconds: 30,
          manualSelectionEnabled: false,
          manualProviderIds: [],
          fallback: "confirmed_failure",
          defaultLocale: "en",
          fallbackLocales: [],
        },
      },
    },
    { action: "lifecycle", kind: "policy", id: policyId, expectedRevision: 1, state: "enabled" },
    { action: "grant", kind: "policy", id: policyId, expectedRevision: 2, projectId: "demo" },
  ];
  for (const [index, command] of commands.entries())
    await client.mutateRuntime(command, { idempotencyKey: `fixture-runtime-${index}` });
};
