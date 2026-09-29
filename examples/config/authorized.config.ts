import { Redacted } from "effect";
import { httpSendAuthorizer } from "@otp-router/engine/delivery";
import { defineConfig } from "@otp-router/server/config";
import base from "./router.config.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
};

// The authority must implement durable idempotent reservations. This example
// still uses fake delivery providers and sends no real messages.
export default defineConfig({
  ...base,
  engine: {
    ...base.engine,
    settings: {
      ...base.engine.settings,
      projects: {
        demo: {
          policyIds: ["login"],
          sendLimit15m: 100,
          sendLimit24h: 1000,
          authorization: "required",
        },
      },
    },
    authorizer: httpSendAuthorizer({
      url: required("OTP_ROUTER_AUTHORIZATION_URL"),
      token: Redacted.make(required("OTP_ROUTER_AUTHORIZATION_TOKEN")),
    }),
  },
});
