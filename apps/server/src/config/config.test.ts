import { it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { expect } from "vitest";
import { FakeProvider, ProviderInstanceIdSchema } from "@otp-router/engine/providers";
import { loadConfiguration, type ConfigurationInput } from "./config.js";

const ring = (byte: number) => ({
  active: "v1",
  keys: { v1: Buffer.alloc(32, byte).toString("base64url") },
});
const signingSecret = `whsec_${Buffer.alloc(32, 5).toString("base64")}`;
const entry: ConfigurationInput = {
  settings: {
    databaseUrl: "postgres://unused/local",
    apiKeys: ["independent-api-key-with-at-least-32-bytes"],
  },
  engine: {
    settings: {
      crypto: {
        deploymentId: "config-test",
        encryption: ring(1),
        verification: ring(2),
        fingerprint: ring(3),
        recipientKey: Buffer.alloc(32, 4).toString("base64url"),
      },
      webhook: { url: "https://example.com/events", signingSecret },
      defaultLocale: "en",
      fallbackLocales: [],
      policies: { login: { managed: {}, providerInstanceIds: ["fake"] } },
      purposes: { login: ["login"] },
      deploymentSendLimit15m: 10,
      deploymentSendLimit24h: 100,
    },
    providers: [
      FakeProvider.make({
        instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)("fake"),
        enabled: true,
        settingsFingerprint: "config-test",
        config: { outcome: "accepted", callbackSecret: Redacted.make("callback") },
        templates: {},
      }),
    ],
  },
};

it.effect("rejects API credentials that reuse the engine's signing secret", () =>
  Effect.gen(function* () {
    for (const apiKey of [signingSecret, signingSecret.slice(6)]) {
      const result = yield* loadConfiguration({
        ...entry,
        settings: { ...entry.settings, apiKeys: [apiKey] },
      }).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_keys" } });
    }
    expect((yield* loadConfiguration(entry).pipe(Effect.result))._tag).toBe("Success");
  }),
);
