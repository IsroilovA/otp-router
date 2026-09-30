import { Schema } from "effect";
import { expect, it } from "vitest";
import { RuntimeCommand } from "./contracts.js";

it("rejects commands whose action or payload does not apply to their resource kind", () => {
  const target = { id: "resource", expectedRevision: 1 };
  for (const command of [
    { ...target, action: "lifecycle", kind: "scope", state: "disabled" },
    { ...target, action: "rotate", kind: "policy", purpose: "send", secrets: {} },
    { ...target, action: "revoke-secret", kind: "instance", versionId: "secret" },
    { ...target, action: "invalidate", kind: "account", revision: 1 },
    { ...target, action: "grant", kind: "scope", projectId: "project" },
    { ...target, action: "grant", kind: "account", projectId: "project" },
    {
      ...target,
      action: "update",
      kind: "instance",
      settings: { sendLimit15m: 1, sendLimit24h: 1 },
    },
    {
      action: "create",
      id: "scope",
      data: { kind: "scope", limits: { sendLimit15m: 1, sendLimit24h: 1 } },
      firstInstance: {
        id: "instance",
        settings: { label: "sender", execution: {}, templates: {}, sendTimeoutMs: 1000 },
        scopeIds: [],
      },
    },
  ]) {
    expect(Schema.is(RuntimeCommand)(command)).toBe(false);
  }
});
