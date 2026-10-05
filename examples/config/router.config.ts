import { defineConfig } from "@otp-router/server/config";
import { FakeProvider } from "@otp-router/engine/providers";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
};

const apiKey = required("OTP_ROUTER_API_KEY");
const encryptionKey = required("OTP_ROUTER_ENCRYPTION_KEY");
const verificationKey = required("OTP_ROUTER_VERIFICATION_KEY");
const fingerprintKey = required("OTP_ROUTER_FINGERPRINT_KEY");
const recipientKey = required("OTP_ROUTER_RECIPIENT_KEY");

const keyRing = (value: string) => ({ active: "v1", keys: { v1: value } });

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
      administration: {
        principalIds: ["backend"],
        administrators: {
          admin: {
            runtimeActions: ["read", "manage", "rotate", "policy", "assign", "audit"],
            resourceIds: [],
            resourcePrefixes: ["demo", "fake", "login"],
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
    adapters: [FakeProvider],
  },
  settings: {
    databaseUrl: required("DATABASE_URL"),
    administrators: [{ id: "admin", keys: [required("OTP_ROUTER_ADMIN_KEY")] }],
    principals: [{ id: "backend", keys: [apiKey] }],
    host: process.env["OTP_ROUTER_HOST"] ?? "127.0.0.1",
    internalHost: process.env["OTP_ROUTER_INTERNAL_HOST"] ?? "127.0.0.1",
  },
});
