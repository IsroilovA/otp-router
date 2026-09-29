import { Redacted, Schema } from "effect";
import { defineConfig } from "@otp-router/server/config";
import { FakeProvider, ProviderInstanceIdSchema } from "@otp-router/engine/providers";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
};

const apiKey = required("OTP_ROUTER_API_KEY");
const callbackSecret = required("OTP_ROUTER_FAKE_CALLBACK_SECRET");
const encryptionKey = required("OTP_ROUTER_ENCRYPTION_KEY");
const verificationKey = required("OTP_ROUTER_VERIFICATION_KEY");
const fingerprintKey = required("OTP_ROUTER_FINGERPRINT_KEY");
const recipientKey = required("OTP_ROUTER_RECIPIENT_KEY");

const keyRing = (value: string) => ({ active: "v1", keys: { v1: value } });
const fakeProviderId = Schema.decodeUnknownSync(ProviderInstanceIdSchema)("fake-primary");

const webhookUrl = process.env["OTP_ROUTER_WEBHOOK_URL"];

export default defineConfig({
  engine: {
    settings: {
      ...(webhookUrl === undefined
        ? {}
        : {
            webhook: {
              url: webhookUrl,
              signingSecret: required("OTP_ROUTER_WEBHOOK_SIGNING_SECRET"),
            },
          }),
      crypto: {
        deploymentId: "local-demo",
        encryption: keyRing(encryptionKey),
        verification: keyRing(verificationKey),
        fingerprint: keyRing(fingerprintKey),
        recipientKey,
      },
      defaultLocale: "en",
      fallbackLocales: [],
      policies: {
        login: {
          managed: {},
          providerInstanceIds: [fakeProviderId],
        },
      },
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
            creationPrefixes: ["demo"],
            grantablePrincipalIds: ["backend"],
            editableSettings: ["authorizationRequired", "sendLimit15m", "sendLimit24h"],
            sendLimit15mCeiling: 1000000,
            sendLimit24hCeiling: 1000000,
            mayDisableAuthorization: true,
          },
        },
        authorizationFloor: false,
      },
      deploymentSendLimit15m: 100,
      deploymentSendLimit24h: 1_000,
    },
    providers: [
      FakeProvider.make({
        instanceId: fakeProviderId,
        enabled: true,
        compatibilityRevision: "local-demo-fake-v1",
        config: {
          outcome: "accepted",
          callbackSecret: Redacted.make(callbackSecret),
        },
        templates: {},
      }),
    ],
  },
  settings: {
    databaseUrl: required("DATABASE_URL"),
    administrators: [{ id: "admin", keys: [required("OTP_ROUTER_ADMIN_KEY")] }],
    principals: [{ id: "backend", keys: [apiKey] }],
    host: process.env["OTP_ROUTER_HOST"] ?? "127.0.0.1",
    internalHost: process.env["OTP_ROUTER_INTERNAL_HOST"] ?? "127.0.0.1",
  },
});
