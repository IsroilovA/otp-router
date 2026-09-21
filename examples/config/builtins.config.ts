import { Redacted, Schema } from "effect";
import { defineConfig } from "@otp-router/server/config";
import {
  MetaProvider,
  PlayMobileProvider,
  ProviderInstanceIdSchema,
  TelegramProvider,
} from "@otp-router/engine/providers";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
};
const keyRing = (name: string) => ({ active: "v1", keys: { v1: required(name) } });
const instanceId = Schema.decodeUnknownSync(ProviderInstanceIdSchema);
const telegram = instanceId("telegram-main");
const whatsapp = instanceId("whatsapp-main");
const sms = instanceId("sms-main");

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
        deploymentId: required("OTP_ROUTER_DEPLOYMENT_ID"),
        encryption: keyRing("OTP_ROUTER_ENCRYPTION_KEY"),
        verification: keyRing("OTP_ROUTER_VERIFICATION_KEY"),
        fingerprint: keyRing("OTP_ROUTER_FINGERPRINT_KEY"),
        recipientKey: required("OTP_ROUTER_RECIPIENT_KEY"),
      },
      defaultLocale: "en",
      fallbackLocales: ["en"],
      policies: {
        login: {
          managed: {},
          providerInstanceIds: [telegram, whatsapp, sms],
          manualSelectionEnabled: true,
        },
      },
      purposes: { login: ["login"] },
      deploymentSendLimit15m: 100,
      deploymentSendLimit24h: 1_000,
    },
    providers: [
      TelegramProvider.make({
        instanceId: telegram,
        enabled: true,
        settingsFingerprint: "telegram-main-settings-v1",
        config: {
          apiToken: Redacted.make(required("TELEGRAM_GATEWAY_TOKEN")),
          callbackUrl: required("TELEGRAM_CALLBACK_URL"),
          callbackMaxAgeSeconds: 300,
        },
        templates: {},
      }),
      MetaProvider.make({
        instanceId: whatsapp,
        enabled: true,
        settingsFingerprint: "whatsapp-main-settings-v1",
        config: {
          accessToken: Redacted.make(required("META_ACCESS_TOKEN")),
          appSecret: Redacted.make(required("META_APP_SECRET")),
          verifyToken: Redacted.make(required("META_VERIFY_TOKEN")),
          phoneNumberId: required("META_PHONE_NUMBER_ID"),
          apiVersion: required("META_API_VERSION"),
        },
        templates: {
          en: {
            name: required("META_AUTHENTICATION_TEMPLATE"),
            languageCode: "en_US",
            codeButtonIndex: 0,
          },
        },
      }),
      PlayMobileProvider.make({
        instanceId: sms,
        enabled: true,
        settingsFingerprint: "sms-main-settings-v1",
        config: {
          username: Redacted.make(required("PLAY_MOBILE_USERNAME")),
          password: Redacted.make(required("PLAY_MOBILE_PASSWORD")),
          originator: required("PLAY_MOBILE_ORIGINATOR"),
          endpoint: "https://send.smsxabar.uz/broker-api/send",
        },
        templates: { en: { text: "Your verification code is {{code}}." } },
      }),
    ],
  },
  settings: {
    databaseUrl: required("DATABASE_URL"),
    apiKeys: [required("OTP_ROUTER_API_KEY")],
    host: process.env["OTP_ROUTER_HOST"] ?? "127.0.0.1",
    internalHost: process.env["OTP_ROUTER_INTERNAL_HOST"] ?? "127.0.0.1",
  },
});
