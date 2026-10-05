import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { assertCapabilities } from "../config/deployment.js";
import { RouterConfig } from "../config/runtime.js";
import { rows } from "../database/query.js";
import { transaction } from "../database/transaction.js";
import { DomainError } from "../errors.js";
import { scoped } from "../projects/permissions.js";
import {
  Assignment,
  RuntimeAdministration,
  RuntimeAuditEvent,
  RuntimePageInput,
} from "./contracts.js";
import { authorizeRuntime, mutateRuntime } from "./mutate.js";
import { publicResource, ResourceRecord, resource } from "./store.js";

export const RuntimeAdministrationLive = Layer.effect(
  RuntimeAdministration,
  Effect.gen(function* () {
    const config = yield* RouterConfig;
    const sql = yield* SqlClient.SqlClient;
    const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((error) =>
          error instanceof DomainError
            ? error
            : new DomainError({ code: "temporarily_unavailable" }),
        ),
      );
    const read = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      run(transaction(assertCapabilities(config).pipe(Effect.andThen(effect))));
    return {
      mutate: (request) => run(mutateRuntime(config, request)),
      get: (actorId, kind, id) =>
        read(
          authorizeRuntime(config, actorId, "read", id).pipe(
            Effect.andThen(resource(kind, id)),
            Effect.map(publicResource),
          ),
        ),
      list: (actorId, kind, input) =>
        read(
          Effect.gen(function* () {
            const permissions = yield* authorizeRuntime(config, actorId, "read");
            const page = yield* Schema.decodeUnknownEffect(RuntimePageInput)(input);
            const limit = page.limit ?? 100;
            const found = yield* rows(
              ResourceRecord,
              sql`SELECT * FROM otp_router.runtime_resources WHERE kind = ${kind} AND id > ${page.after ?? ""} AND (id IN (SELECT jsonb_array_elements_text(${JSON.stringify(permissions.resourceIds)}::jsonb)) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(permissions.resourcePrefixes)}::jsonb) p(prefix) WHERE starts_with(id,p.prefix))) ORDER BY id LIMIT ${limit + 1}`,
            );
            const visible = found.slice(0, limit);
            return {
              resources: visible.map(publicResource),
              nextCursor: found.length > limit ? (visible.at(-1)?.id ?? null) : null,
            };
          }),
        ),
      assignments: (actorId, projectId) =>
        read(
          Effect.gen(function* () {
            const permissions = yield* authorizeRuntime(config, actorId, "assign");
            if (!scoped(permissions, projectId))
              return yield* Effect.fail(new DomainError({ code: "admin_forbidden" }));
            return yield* rows(
              Assignment,
              sql`SELECT id,project_id AS "projectId",kind,resource_id AS "resourceId",revoked_at IS NOT NULL AS revoked FROM otp_router.runtime_grants WHERE project_id = ${projectId} AND (resource_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(permissions.resourceIds)}::jsonb)) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(permissions.resourcePrefixes)}::jsonb) p(prefix) WHERE starts_with(resource_id,p.prefix))) ORDER BY id`,
            );
          }),
        ),
      audit: (actorId, kind, id, input) =>
        read(
          Effect.gen(function* () {
            yield* authorizeRuntime(config, actorId, "audit", id);
            const page = yield* Schema.decodeUnknownEffect(RuntimePageInput)(input);
            if (page.after !== undefined && !/^\d{1,18}$/u.test(page.after))
              return yield* Effect.fail(new DomainError({ code: "invalid_request" }));
            const limit = page.limit ?? 100;
            const found = yield* rows(
              Schema.Struct({ ...RuntimeAuditEvent.fields, sequence: Schema.String }),
              sql`SELECT sequence::text,id,actor_id AS "actorId",action,kind,resource_id AS "resourceId",revision,project_id AS "projectId",to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt" FROM otp_router.runtime_events WHERE kind = ${kind} AND resource_id = ${id} AND sequence > ${page.after ?? "0"}::bigint ORDER BY otp_router.runtime_events.sequence LIMIT ${limit + 1}`,
            );
            const visible = found.slice(0, limit);
            return {
              events: visible.map(({ sequence: _sequence, ...event }) => event),
              nextCursor: found.length > limit ? (visible.at(-1)?.sequence ?? null) : null,
            };
          }),
        ),
    };
  }),
);
