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
  settingsFingerprint: "test",
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
    apiKeys: ["configuration-secret-32-characters-long"],
    defaultLocale: "en",
    fallbackLocales: [],
    policies: { login: { providerInstanceIds: ["fake"] } },
    purposes: { login: ["login"] },
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
        {
          ...base.settings,
          policies: {
            login: {
              providerInstanceIds: ["fake"],
              lifetimeSeconds: 60,
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
        settingsFingerprint: "meta-account",
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
