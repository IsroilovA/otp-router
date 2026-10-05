import { assertCapabilities } from "../config/deployment.js";
import { transaction } from "../database/transaction.js";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { RouterConfig } from "../config/runtime.js";
import { rows } from "../database/query.js";
import { DomainError } from "../errors.js";
import { AdminEvent, PageInput, Projects } from "./contracts.js";
import { mutateProject } from "./mutate.js";
import { authorizeAdmin, scoped } from "./permissions.js";
import { lockProject, projectSnapshot } from "./store.js";

export const ProjectsLive = Layer.effect(
  Projects,
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
    const pageInput = (input: typeof PageInput.Type) =>
      Schema.decodeUnknownEffect(PageInput)(input, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => new DomainError({ code: "invalid_request" })),
      );
    return {
      mutate: (request) => run(mutateProject(config, request)),
      get: (actorId, projectId) =>
        read(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* authorizeAdmin(config, actorId, "read", projectId);
              yield* lockProject(projectId);
              return yield* projectSnapshot(projectId);
            }),
          ),
        ),
      list: (actorId, input) =>
        read(
          sql.withTransaction(
            Effect.gen(function* () {
              const permissions = yield* authorizeAdmin(config, actorId, "list");
              const page = yield* pageInput(input);
              const limit = page.limit ?? 100;
              // Literal prefix comparison: SQL LIKE wildcards have no permission meaning.
              const found = yield* rows(
                Schema.Struct({ id: Schema.String }),
                sql`SELECT id FROM otp_router.projects WHERE id > ${page.cursor ?? ""} AND (id IN (SELECT jsonb_array_elements_text(${JSON.stringify(permissions.projectIds)}::jsonb)) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(permissions.creationPrefixes)}::jsonb) p(prefix) WHERE starts_with(id,p.prefix))) ORDER BY id LIMIT ${limit + 1}`,
              );
              const projects = [];
              for (const row of found.slice(0, limit)) {
                if (!scoped(permissions, row.id))
                  return yield* Effect.fail(new DomainError({ code: "admin_forbidden" }));
                yield* lockProject(row.id);
                projects.push(yield* projectSnapshot(row.id));
              }
              return {
                projects,
                nextCursor: found.length > limit ? (projects.at(-1)?.id ?? null) : null,
              };
            }),
          ),
        ),
      audit: (actorId, projectId, input) =>
        read(
          Effect.gen(function* () {
            yield* authorizeAdmin(config, actorId, "audit", projectId);
            const page = yield* pageInput(input);
            yield* projectSnapshot(projectId);
            const cursor = page.cursor ?? "0";
            if (!/^\d{1,10}$/u.test(cursor))
              return yield* Effect.fail(new DomainError({ code: "invalid_request" }));
            const limit = page.limit ?? 100;
            const found = yield* rows(
              AdminEvent,
              sql`SELECT id,project_id AS "projectId",actor_id AS "actorId",action,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",revision,details FROM otp_router.project_admin_events WHERE project_id = ${projectId} AND revision > ${cursor}::bigint ORDER BY revision LIMIT ${limit + 1}`,
            );
            const events = found.slice(0, limit);
            return {
              events,
              nextCursor: found.length > limit ? String(events.at(-1)?.revision) : null,
            };
          }),
        ),
    };
  }),
);
