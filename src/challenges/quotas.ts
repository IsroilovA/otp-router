import { SqlClient } from "effect/unstable/sql";
import { Effect, Schema } from "effect";
import { rows } from "../database/query.js";
import { DomainError } from "./contracts.js";
import type { Settings } from "../config/config.js";
export interface Limit {
  readonly identity: string;
  readonly kind: "create" | "send" | "guess";
  readonly maximum: number;
  readonly windowMs: number;
}
export const recipientLimit = (token: string, kind: Limit["kind"], maximum: number): Limit => ({
  identity: `recipient:${token}`,
  kind,
  maximum,
  windowMs: 900000,
});
export const commonSendLimits = (settings: Settings, token: string): readonly Limit[] => [
  recipientLimit(token, "send", settings.recipientSendLimit15m),
  {
    identity: "deployment",
    kind: "send",
    maximum: settings.deploymentSendLimit15m,
    windowMs: 900000,
  },
  {
    identity: "deployment",
    kind: "send",
    maximum: settings.deploymentSendLimit24h,
    windowMs: 86400000,
  },
];
export const providerSendLimits = (settings: Settings, providerId: string): readonly Limit[] => {
  const maximum = settings.providerSendLimits15m[providerId];
  return maximum === undefined
    ? []
    : [{ identity: `provider:${providerId}`, kind: "send", maximum, windowMs: 900000 }];
};
export const sendLimits = (
  settings: Settings,
  token: string,
  providerId: string,
): readonly Limit[] => [
  ...commonSendLimits(settings, token),
  ...providerSendLimits(settings, providerId),
];
export const lockQuotas = (limits: readonly Limit[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const identity of [...new Set(limits.map((limit) => limit.identity))].sort()) {
      yield* sql`INSERT INTO otp_router.quota_keys(identity) VALUES (${identity}) ON CONFLICT DO NOTHING`;
      yield* sql`SELECT identity FROM otp_router.quota_keys WHERE identity = ${identity} FOR UPDATE`;
    }
  });
export const quotaRetryAt = (limits: readonly Limit[], time: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let retry: number | undefined;
    for (const limit of limits) {
      const events = yield* rows(
        Schema.Struct({ occurred_at: Schema.Date }),
        sql`SELECT occurred_at FROM otp_router.quota_events WHERE identity = ${limit.identity} AND kind = ${limit.kind} AND occurred_at > ${new Date(time.getTime() - limit.windowMs)} ORDER BY occurred_at DESC OFFSET ${limit.maximum - 1} LIMIT 1`,
      );
      const blocking = events[0];
      if (blocking !== undefined)
        retry = Math.max(retry ?? 0, blocking.occurred_at.getTime() + limit.windowMs);
    }
    return retry === undefined ? undefined : new Date(retry).toISOString();
  });
export const checkQuotas = (limits: readonly Limit[], time: Date) =>
  Effect.gen(function* () {
    const retryAt = yield* quotaRetryAt(limits, time);
    if (retryAt !== undefined)
      return yield* Effect.fail(new DomainError({ code: "rate_limited", retryAt }));
  });
export const countQuotas = (limits: readonly Limit[], eventId: string, time: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const identity of new Set(limits.map((limit) => limit.identity))) {
      const limit = limits.find((item) => item.identity === identity);
      if (limit !== undefined)
        yield* sql`INSERT INTO otp_router.quota_events(identity,kind,event_id,occurred_at) VALUES (${identity},${limit.kind},${eventId},${time}) ON CONFLICT DO NOTHING`;
    }
  });
