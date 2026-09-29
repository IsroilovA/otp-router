import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { rows } from "../database/query.js";
import { DomainError } from "../errors.js";
import { ProjectSnapshot } from "./contracts.js";

export const ProjectRecord = Schema.Struct({
  id: Schema.String,
  state: ProjectSnapshot.fields.state,
  revision: Schema.Int,
  send_epoch: Schema.Int,
  authorization_required: Schema.Boolean,
  send_limit_15m: Schema.Int,
  send_limit_24h: Schema.Int,
  created_at: Schema.Date,
});
// Global order: project, request identity, sorted quotas, operation/challenge, event stream.
// Advisory locks cover nonexistent IDs as well as permanently reserved projects.
export const lockProject = (id: string, exclusive = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const key = `project:${id}`;
    if (exclusive) yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
    else yield* sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key},0))`;
  });
export const findProject = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const project = (yield* rows(
      ProjectRecord,
      sql`SELECT * FROM otp_router.projects WHERE id = ${id}`,
    ))[0];
    if (project === undefined)
      return yield* Effect.fail(new DomainError({ code: "project_not_found" }));
    return project;
  });
export const projectSnapshot = (id: string) =>
  Effect.gen(function* () {
    const project = yield* findProject(id);
    const sql = yield* SqlClient.SqlClient;
    const grants = yield* rows(
      Schema.Struct({ id: Schema.String, principal_id: Schema.String, granted_at: Schema.Date }),
      sql`SELECT id,principal_id,granted_at FROM otp_router.project_principal_grants WHERE project_id = ${id} AND revoked_at IS NULL ORDER BY principal_id`,
    );
    return {
      id,
      state: project.state,
      revision: project.revision,
      createdAt: project.created_at.toISOString(),
      settings: {
        authorizationRequired: project.authorization_required,
        sendLimit15m: project.send_limit_15m,
        sendLimit24h: project.send_limit_24h,
      },
      grants: grants.map((grant) => ({
        id: grant.id,
        principalId: grant.principal_id,
        grantedAt: grant.granted_at.toISOString(),
      })),
    } satisfies typeof ProjectSnapshot.Type;
  });
export const requireActiveProject = (project: typeof ProjectRecord.Type) =>
  project.state === "active"
    ? Effect.void
    : Effect.fail(new DomainError({ code: "project_inactive" }));
export const requireAccess = (projectId: string, principalId: string, sending = false) =>
  Effect.gen(function* () {
    yield* lockProject(projectId);
    const sql = yield* SqlClient.SqlClient;
    const grant = (yield* rows(
      Schema.Struct({ id: Schema.String }),
      sql`SELECT id FROM otp_router.project_principal_grants WHERE project_id = ${projectId} AND principal_id = ${principalId} AND revoked_at IS NULL`,
    ))[0];
    if (grant === undefined)
      return yield* Effect.fail(new DomainError({ code: "project_access_denied" }));
    const project = yield* findProject(projectId);
    if (sending) yield* requireActiveProject(project);
    return { project, grantId: grant.id };
  });
export const intentEligible = (intentId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const result = yield* rows(
      Schema.Struct({ eligible: Schema.Boolean }),
      sql`SELECT EXISTS (
    SELECT 1 FROM otp_router.send_intents i
    JOIN otp_router.delivery_operations o ON o.id = i.operation_id
    JOIN otp_router.projects p ON p.id = o.project_id
    JOIN otp_router.project_principal_grants g ON g.id = i.principal_grant_id
    WHERE i.id = ${intentId} AND p.state = 'active' AND p.send_epoch = i.project_send_epoch AND g.revoked_at IS NULL
  ) AS eligible`,
    );
    return result[0]?.eligible === true;
  });
