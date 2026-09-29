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
    administrators: [{ id: "admin", keys: ["admin-test-credential-with-at-least-32-bytes"] }],
    principals: [{ id: "backend", keys: ["independent-api-key-with-at-least-32-bytes"] }],
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
    providers: [
      FakeProvider.make({
        instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)("fake"),
        enabled: true,
        compatibilityRevision: "config-test",
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
        settings: {
          ...entry.settings,
          administrators: [{ id: "admin", keys: ["admin-test-credential-with-at-least-32-bytes"] }],
          principals: [{ id: "backend", keys: [apiKey] }],
        },
      }).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_keys" } });
    }
    expect((yield* loadConfiguration(entry).pipe(Effect.result))._tag).toBe("Success");
  }),
);

it.effect(
  "rejects credentials shared across classes and catalogs missing configured identities",
  () =>
    Effect.gen(function* () {
      for (const settings of [
        {
          ...entry.settings,
          administrators: [{ id: "admin", keys: ["independent-api-key-with-at-least-32-bytes"] }],
        },
        {
          ...entry.settings,
          principals: [
            { id: "unregistered", keys: ["independent-api-key-with-at-least-32-bytes"] },
          ],
        },
        {
          ...entry.settings,
          administrators: [
            { id: "unregistered", keys: ["admin-test-credential-with-at-least-32-bytes"] },
          ],
        },
      ])
        expect(yield* loadConfiguration({ ...entry, settings }).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "invalid_settings" },
        });
    }),
);
