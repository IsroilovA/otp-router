import { SqlClient } from "effect/unstable/sql";
import { Effect, Schema } from "effect";
import { rows } from "../database/query.js";
import { DomainError } from "../errors.js";
import type { Settings } from "../config/config.js";
export interface Limit {
  readonly scope: "recipient" | "project" | "provider" | "deployment";
  readonly scopeId: string;
  readonly kind: "create" | "send" | "guess" | "admission";
  readonly maximum: number;
  readonly windowMs: number;
}
export const recipientLimit = (token: string, kind: Limit["kind"], maximum: number): Limit => ({
  scope: "recipient",
  scopeId: token,
  kind,
  maximum,
  windowMs: 900000,
});
export const commonSendLimits = (
  settings: Settings,
  token: string,
  projectId: string,
): readonly Limit[] => [
  {
    scope: "project",
    scopeId: projectId,
    kind: "send",
    maximum: settings.projects[projectId]?.sendLimit15m ?? 0,
    windowMs: 900000,
  },
  {
    scope: "project",
    scopeId: projectId,
    kind: "send",
    maximum: settings.projects[projectId]?.sendLimit24h ?? 0,
    windowMs: 86400000,
  },
  recipientLimit(token, "send", settings.recipientSendLimit15m),
  {
    scope: "deployment",
    scopeId: "",
    kind: "send",
    maximum: settings.deploymentSendLimit15m,
    windowMs: 900000,
  },
  {
    scope: "deployment",
    scopeId: "",
    kind: "send",
    maximum: settings.deploymentSendLimit24h,
    windowMs: 86400000,
  },
];
export const providerSendLimits = (settings: Settings, providerId: string): readonly Limit[] => {
  const maximum = settings.providerSendLimits15m[providerId];
  return maximum === undefined
    ? []
    : [{ scope: "provider", scopeId: providerId, kind: "send", maximum, windowMs: 900000 }];
};
export const sendLimits = (
  settings: Settings,
  token: string,
  providerId: string,
  projectId: string,
): readonly Limit[] => [
  ...commonSendLimits(settings, token, projectId),
  ...providerSendLimits(settings, providerId),
];
// Lock order: request idempotency, sorted quota identities, operation, then challenge.
// Callers must acquire quotas before row locks to avoid cross-operation deadlocks.
export const lockQuotas = (limits: readonly Limit[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const identity of [
      ...new Set(limits.map((limit) => JSON.stringify([limit.scope, limit.scopeId]))),
    ].sort()) {
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${identity}`},0))`;
    }
  });
export const quotaRetryAt = (limits: readonly Limit[], time: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let retry: number | undefined;
    for (const limit of limits) {
      const events = yield* rows(
        Schema.Struct({ occurred_at: Schema.Date }),
        sql`SELECT e.occurred_at FROM otp_router.quota_allocations a JOIN otp_router.quota_events e ON (e.event_id,e.kind) = (a.event_id,a.kind) WHERE a.scope = ${limit.scope} AND a.scope_id = ${limit.scopeId} AND a.kind = ${limit.kind} AND e.occurred_at > ${new Date(time.getTime() - limit.windowMs)} ORDER BY e.occurred_at DESC OFFSET ${limit.maximum - 1} LIMIT 1`,
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
    for (const kind of new Set(limits.map((limit) => limit.kind)))
      yield* sql`INSERT INTO otp_router.quota_events(kind,event_id,occurred_at) VALUES (${kind},${eventId},${time}) ON CONFLICT DO NOTHING`;
    const allocations = new Map(
      limits.map((limit) => [JSON.stringify([limit.scope, limit.scopeId, limit.kind]), limit]),
    );
    for (const limit of allocations.values()) {
      yield* sql`INSERT INTO otp_router.quota_allocations(scope,scope_id,kind,event_id) VALUES (${limit.scope},${limit.scopeId},${limit.kind},${eventId}) ON CONFLICT DO NOTHING`;
    }
  });

export const admissionLimit = (token: string): Limit => ({
  scope: "recipient",
  scopeId: token,
  kind: "admission",
  maximum: 1,
  windowMs: 30000,
});

export const extendAdmission = (token: string, eventId: string, time: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO otp_router.quota_events(kind,event_id,occurred_at) VALUES ('admission',${eventId},${time}) ON CONFLICT (event_id,kind) DO UPDATE SET occurred_at = GREATEST(quota_events.occurred_at,EXCLUDED.occurred_at)`;
    yield* sql`INSERT INTO otp_router.quota_allocations(scope,scope_id,kind,event_id) VALUES ('recipient',${token},'admission',${eventId}) ON CONFLICT DO NOTHING`;
  });
