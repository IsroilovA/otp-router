import { Redacted, Schema } from "effect";
import { defineConfig } from "otp-router/config";
import { FakeProvider, ProviderInstanceIdSchema } from "otp-router/providers";

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
    apiKeys: [apiKey],
    defaultLocale: "en",
    fallbackLocales: [],
    policies: {
      login: {
        providerInstanceIds: [fakeProviderId],
      },
    },
    purposes: { login: ["login"] },
    deploymentSendLimit15m: 100,
    deploymentSendLimit24h: 1_000,
    host: process.env["OTP_ROUTER_HOST"] ?? "127.0.0.1",
    internalHost: process.env["OTP_ROUTER_INTERNAL_HOST"] ?? "127.0.0.1",
  },
  providers: [
    FakeProvider.make({
      instanceId: fakeProviderId,
      enabled: true,
      settingsFingerprint: "local-demo-fake-v1",
      config: {
        outcome: "accepted",
        callbackSecret: Redacted.make(callbackSecret),
      },
      templates: {},
    }),
  ],
});
