import { findProject } from "../projects/store.js";
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
export const commonSendLimits = (settings: Settings, token: string, projectId: string) =>
  Effect.gen(function* () {
    const project = yield* findProject(projectId);
    return [
      {
        scope: "project",
        scopeId: projectId,
        kind: "send",
        maximum: project.send_limit_15m,
        windowMs: 900000,
      },
      {
        scope: "project",
        scopeId: projectId,
        kind: "send",
        maximum: project.send_limit_24h,
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
    ] satisfies readonly Limit[];
  });
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
) =>
  commonSendLimits(settings, token, projectId).pipe(
    Effect.map((limits) => [...limits, ...providerSendLimits(settings, providerId)]),
  );
// Lock order: project, request idempotency, sorted quota identities, operation, then challenge.
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
export const quotaBlocks = (limits: readonly Limit[], time: Date) =>
  Effect.gen(function* () {
    if (limits.length === 0) return [];
    const sql = yield* SqlClient.SqlClient;
    return yield* rows(
      Schema.Struct({ scope: Schema.String, scope_id: Schema.String, retry_at: Schema.Date }),
      sql`SELECT l.scope, l."scopeId" AS scope_id,
        max(blocking.occurred_at + l."windowMs" * interval '1 millisecond') AS retry_at
      FROM jsonb_to_recordset(${JSON.stringify(limits)}::jsonb)
        AS l(scope text, "scopeId" text, kind text, maximum integer, "windowMs" integer)
      CROSS JOIN LATERAL (
        SELECT e.occurred_at FROM otp_router.quota_allocations a
        JOIN otp_router.quota_events e ON (e.event_id,e.kind) = (a.event_id,a.kind)
        WHERE a.scope = l.scope AND a.scope_id = l."scopeId" AND a.kind = l.kind
          AND e.occurred_at > ${time}::timestamptz - l."windowMs" * interval '1 millisecond'
        ORDER BY e.occurred_at DESC OFFSET l.maximum - 1 LIMIT 1
      ) blocking GROUP BY l.scope,l."scopeId"`,
    );
  });
export const quotaRetryAt = (limits: readonly Limit[], time: Date) =>
  quotaBlocks(limits, time).pipe(
    Effect.map((blocks) =>
      blocks
        .map((block) => block.retry_at.toISOString())
        .sort()
        .at(-1),
    ),
  );
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
