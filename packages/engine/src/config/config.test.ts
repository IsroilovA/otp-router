import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { FakeProvider } from "../providers/index.js";
import { type Configuration, loadConfiguration } from "./config.js";

const ring = (n: number) => ({
  active: "a",
  keys: { a: Buffer.alloc(32, n).toString("base64url") },
});
const base: Configuration = {
  settings: {
    crypto: {
      deploymentId: "configuration",
      encryption: ring(1),
      verification: ring(2),
      fingerprint: ring(3),
      recipientKey: Buffer.alloc(32, 4).toString("base64url"),
    },
    administration: {
      principalIds: ["backend"],
      administrators: {
        admin: {
          runtimeActions: [],
          resourceIds: [],
          resourcePrefixes: [],
          actions: [
            "create",
            "read",
            "list",
            "update",
            "suspend",
            "reactivate",
            "retire",
            "grant",
            "revoke",
            "audit",
          ],
          projectIds: [],
          creationPrefixes: ["demo", "alpha", "beta"],
          grantablePrincipalIds: ["backend"],
          editableSettings: ["authorizationRequired", "sendLimit15m", "sendLimit24h"],
          sendLimit15mCeiling: 1000000,
          sendLimit24hCeiling: 1000000,
          mayDisableAuthorization: true,
        },
      },
      authorizationFloor: false,
    },
    deploymentSendLimit15m: 10,
    deploymentSendLimit24h: 100,
  },
  adapters: [FakeProvider],
};
it.effect(
  "rejects unsupported fallback/retry configuration, invalid bounds and reused secret keys",
  () =>
    Effect.gen(function* () {
      for (const settings of [
        { ...base.settings, automaticSendRetries: 1 },
        { ...base.settings, timedFallbackSeconds: 5 },
        { ...base.settings, deploymentSendLimit24h: 0 },
        { ...base.settings, deploymentSendLimit15m: 2147483648 },
        { ...base.settings, deploymentSendLimit24h: 2147483648 },
        ...[
          "http://example.com/hooks",
          "https://user:password@example.com/hooks",
          "https://example.com/hooks#fragment",
        ].map((url) => ({
          ...base.settings,
          webhook: { url, signingSecret: `whsec_${Buffer.alloc(32, 9).toString("base64")}` },
        })),
        {
          ...base.settings,
          webhook: {
            url: "https://example.com/hooks",
            signingSecret: `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
          },
        },
        {
          ...base.settings,
          policies: {
            login: {
              providerInstanceIds: ["fake"],
              managed: { lifetimeSeconds: 60 },
              maxLifetimeSeconds: 60,
              resendCooldownSeconds: 60,
            },
          },
        },
        {
          ...base.settings,
          crypto: {
            ...base.settings.crypto,
            recipientKey: Buffer.alloc(32, 1).toString("base64url"),
          },
        },
      ])
        expect((yield* loadConfiguration({ ...base, settings }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
    }),
);

it.effect("rejects duplicate implementations and malformed adapter contracts", () =>
  Effect.gen(function* () {
    expect(
      (yield* loadConfiguration({ ...base, adapters: [FakeProvider, FakeProvider] }).pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    for (const constraints of [
      { ...FakeProvider.constraints, minCodeLength: Number.NaN },
      { ...FakeProvider.constraints, maxCodeLength: Number.POSITIVE_INFINITY },
      { ...FakeProvider.constraints, minCodeLength: -1 },
      { ...FakeProvider.constraints, minCodeLength: 8, maxCodeLength: 6 },
      { ...FakeProvider.constraints, minDeliveryWindowMs: -1 },
    ])
      expect(
        (yield* loadConfiguration({ ...base, adapters: [{ ...FakeProvider, constraints }] }).pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    for (const defaultSendTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(
        (yield* loadConfiguration({
          ...base,
          adapters: [{ ...FakeProvider, defaultSendTimeoutMs }],
        }).pipe(Effect.result))._tag,
      ).toBe("Failure");
  }),
);
