import { it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { expect } from "vitest";
import { FakeProvider, ProviderInstance, ProviderInstanceIdSchema } from "../providers/index.js";
import { loadConfiguration, type Configuration } from "./config.js";
const ring = (n: number) => ({
  active: "a",
  keys: { a: Buffer.alloc(32, n).toString("base64url") },
});
const provider = FakeProvider.make({
  instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)("fake"),
  enabled: true,
  compatibilityRevision: "test",
  config: { outcome: "accepted", callbackSecret: Redacted.make("callback") },
  templates: {},
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
    defaultLocale: "en",
    fallbackLocales: [],
    policies: { login: { managed: {}, providerInstanceIds: ["fake"] } },
    purposes: { login: ["login"] },
    administration: {
      principalIds: ["backend"],
      administrators: {
        admin: {
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
  providers: [provider],
};
it.effect(
  "rejects unsupported fallback/retry configuration, invalid bounds and reused secret keys",
  () =>
    Effect.gen(function* () {
      for (const settings of [
        { ...base.settings, automaticSendRetries: 1 },
        { ...base.settings, timedFallbackSeconds: 5 },
        { ...base.settings, deploymentSendLimit24h: 0 },
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
it.effect("validates adapter defaults even when a valid timeout override is supplied", () =>
  Effect.gen(function* () {
    const ready = Context.get(yield* Layer.build(provider), ProviderInstance);
    for (const defaultSendTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalid = Layer.succeed(ProviderInstance, {
        ...ready,
        defaultSendTimeoutMs,
        sendTimeoutMs: 1000,
      });
      expect(
        (yield* loadConfiguration({ ...base, providers: [invalid] }).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }
    expect(
      (yield* loadConfiguration({ ...base, providers: [provider, provider] }).pipe(Effect.result))
        ._tag,
    ).toBe("Failure");
  }),
);
it.effect("rejects provider budget and label keys without registered instances", () =>
  Effect.gen(function* () {
    for (const settings of [
      { ...base.settings, providerSendLimits15m: { missing: 10 } },
      { ...base.settings, providerLabels: { missing: "Unregistered" } },
    ]) {
      const result = yield* loadConfiguration({ ...base, settings }).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "unknown_provider" },
      });
    }
  }),
);

it.effect("rejects malformed provider constraints at registration", () =>
  Effect.gen(function* () {
    const ready = Context.get(yield* Layer.build(provider), ProviderInstance);
    for (const constraints of [
      { ...ready.constraints, minCodeLength: Number.NaN },
      { ...ready.constraints, maxCodeLength: Number.POSITIVE_INFINITY },
      { ...ready.constraints, minCodeLength: -1 },
      { ...ready.constraints, minCodeLength: 8, maxCodeLength: 6 },
      { ...ready.constraints, minDeliveryWindowMs: Number.NEGATIVE_INFINITY },
      { ...ready.constraints, minDeliveryWindowMs: -1 },
    ]) {
      const result = yield* loadConfiguration({
        ...base,
        providers: [Layer.succeed(ProviderInstance, { ...ready, constraints })],
      }).pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid_provider_registration" },
      });
    }
  }),
);
it.effect(
  "checks every configured template at startup, including locales not selected by defaults",
  () =>
    Effect.gen(function* () {
      const { MetaProvider } = yield* Effect.promise(() => import("../providers/meta.js"));
      const configuration = yield* Schema.decodeUnknownEffect(MetaProvider.configSchema)({
        accessToken: "token",
        appSecret: "secret",
        verifyToken: "verify",
        phoneNumberId: "1234",
        apiVersion: "v23.0",
      });
      const layer = MetaProvider.make({
        instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)("meta"),
        enabled: true,
        compatibilityRevision: "meta-account",
        config: configuration,
        templates: {
          en: { name: "otp", languageCode: "en", codeButtonIndex: 0 },
          uz: { name: "otp", languageCode: "uz", codeButtonIndex: 99 },
        },
      });
      expect((yield* Layer.build(layer).pipe(Effect.result))._tag).toBe("Failure");
    }),
);

it.effect(
  "rejects a provider whose timeout and delivery minimum cannot fit the policy lifetime",
  () =>
    Effect.gen(function* () {
      const ready = Context.get(yield* Layer.build(provider), ProviderInstance);
      for (const sendTimeoutMs of [300000, 300001]) {
        const result = yield* loadConfiguration({
          ...base,
          providers: [Layer.succeed(ProviderInstance, { ...ready, sendTimeoutMs })],
        }).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { reason: "incompatible_provider_constraints" },
        });
      }
    }),
);

it.effect("accepts longer managed lifetimes within the delivery policy maximum", () =>
  Effect.gen(function* () {
    for (const lifetimeSeconds of [900, 3600]) {
      const loaded = yield* loadConfiguration({
        ...base,
        settings: {
          ...base.settings,
          policies: {
            login: {
              providerInstanceIds: ["fake"],
              managed: { lifetimeSeconds },
              maxLifetimeSeconds: lifetimeSeconds,
            },
          },
        },
      });
      expect(loaded.settings.policies["login"]?.managed?.lifetimeSeconds).toBe(lifetimeSeconds);
    }
    const result = yield* loadConfiguration({
      ...base,
      settings: {
        ...base.settings,
        policies: {
          login: {
            providerInstanceIds: ["fake"],
            managed: { lifetimeSeconds: 900 },
            maxLifetimeSeconds: 899,
          },
        },
      },
    }).pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_policy" } });
  }),
);
