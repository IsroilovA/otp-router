import { transaction } from "../database/transaction.js";
import { assertCatalog } from "./catalog.js";
import { createHash, randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { RuntimeConfiguration } from "../config/config.js";
import { canonical } from "../crypto.js";
import { rows } from "../database/query.js";
import { DomainError } from "../errors.js";
import {
  AdminRequest,
  AdminResult,
  ChangeDetails,
  type AdminCommand,
  type AdminPermissions,
  type ProjectSnapshot,
} from "./contracts.js";
import { authorizeCommand, authorizeSettingChanges } from "./permissions.js";
import { lockProject, projectSnapshot } from "./store.js";

const addGrant = (projectId: string, principalId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = randomUUID();
    yield* sql`INSERT INTO otp_router.project_principal_grants(id,project_id,principal_id) VALUES (${id},${projectId},${principalId})`;
    return id;
  });
const createProject = (
  command: Extract<typeof AdminCommand.Type, { action: "create" }>,
  permissions: typeof AdminPermissions.Type,
) =>
  Effect.gen(function* () {
    const { id, settings, principalIds } = command.input;
    if (
      permissions.editableSettings.length !== 3 ||
      new Set(permissions.editableSettings).size !== 3
    )
      return yield* Effect.fail(new DomainError({ code: "admin_forbidden" }));
    const sql = yield* SqlClient.SqlClient;
    const exists = yield* rows(
      Schema.Struct({ id: Schema.String }),
      sql`SELECT id FROM otp_router.projects WHERE id = ${id}`,
    );
    if (exists.length > 0) return yield* Effect.fail(new DomainError({ code: "project_conflict" }));
    yield* sql`INSERT INTO otp_router.projects(id,state,revision,authorization_required,send_limit_15m,send_limit_24h) VALUES (${id},'active',1,${settings.authorizationRequired},${settings.sendLimit15m},${settings.sendLimit24h})`;
    for (const principal of principalIds) yield* addGrant(id, principal);
    const snapshot = yield* projectSnapshot(id);
    return {
      action: "create",
      settings,
      grants: snapshot.grants,
    } satisfies typeof ChangeDetails.Type;
  });
const changeProject = (
  command: Exclude<typeof AdminCommand.Type, { action: "create" }>,
  permissions: typeof AdminPermissions.Type,
  before: typeof ProjectSnapshot.Type,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (before.revision !== command.expectedRevision)
      return yield* Effect.fail(new DomainError({ code: "revision_conflict" }));
    switch (command.action) {
      case "update": {
        yield* authorizeSettingChanges(permissions, before.settings, command.settings);
        if (canonical(before.settings) === canonical(command.settings)) return undefined;
        yield* sql`UPDATE otp_router.projects SET authorization_required = ${command.settings.authorizationRequired}, send_limit_15m = ${command.settings.sendLimit15m}, send_limit_24h = ${command.settings.sendLimit24h} WHERE id = ${before.id}`;
        return {
          action: "update",
          before: before.settings,
          after: command.settings,
        } satisfies typeof ChangeDetails.Type;
      }
      case "grant": {
        if (before.grants.some((grant) => grant.principalId === command.principalId))
          return undefined;
        const grantId = yield* addGrant(before.id, command.principalId);
        return {
          action: "grant",
          grantId,
          principalId: command.principalId,
        } satisfies typeof ChangeDetails.Type;
      }
      case "revoke": {
        const grant = before.grants.find((value) => value.principalId === command.principalId);
        if (grant === undefined) return undefined;
        yield* sql`UPDATE otp_router.project_principal_grants SET revoked_at = clock_timestamp() WHERE id = ${grant.id} AND revoked_at IS NULL`;
        return {
          action: "revoke",
          grantId: grant.id,
          principalId: grant.principalId,
        } satisfies typeof ChangeDetails.Type;
      }
      case "suspend":
      case "reactivate":
      case "retire": {
        const state =
          command.action === "suspend"
            ? "suspended"
            : command.action === "reactivate"
              ? "active"
              : "retired";
        if (before.state === state) return undefined;
        if (before.state === "retired")
          return yield* Effect.fail(new DomainError({ code: "project_conflict" }));
        yield* sql`UPDATE otp_router.projects SET state = ${state}, send_epoch = send_epoch + ${state === "active" ? 0 : 1} WHERE id = ${before.id}`;
        return {
          action: command.action,
          before: before.state,
          after: state,
        } satisfies typeof ChangeDetails.Type;
      }
    }
  });
export const mutateProject = (config: RuntimeConfiguration, input: typeof AdminRequest.Type) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(AdminRequest)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new DomainError({ code: "invalid_request" })));
    const { actorId, key, command } = request;
    // Current ceilings apply even to an old receipt. No mutation or audit on replay.
    const permissions = yield* authorizeCommand(config, actorId, command);
    const projectId = command.action === "create" ? command.input.id : command.projectId;
    const fingerprint = createHash("sha256").update(canonical(command)).digest("hex");
    const sql = yield* SqlClient.SqlClient;
    return yield* transaction(
      Effect.gen(function* () {
        yield* assertCatalog(config);
        yield* lockProject(projectId, true);
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${canonical(["admin", actorId, key])},0))`;
        yield* sql`DELETE FROM otp_router.admin_request_receipts WHERE actor_id = ${actorId} AND key = ${key} AND retain_until <= clock_timestamp()`;
        const receipt = (yield* rows(
          Schema.Struct({
            fingerprint: Schema.String,
            response: AdminResult,
            details: Schema.NullOr(ChangeDetails),
          }),
          sql`SELECT r.fingerprint,r.response,e.details FROM otp_router.admin_request_receipts r LEFT JOIN otp_router.project_admin_events e ON e.id = r.event_id WHERE r.actor_id = ${actorId} AND r.key = ${key}`,
        ))[0];
        if (receipt !== undefined) {
          if (receipt.fingerprint !== fingerprint)
            return yield* Effect.fail(new DomainError({ code: "idempotency_conflict" }));
          // A no-op has no event. Recheck permissions only for this request's original change.
          if (receipt.details?.action === "update")
            yield* authorizeSettingChanges(
              permissions,
              receipt.details.before,
              receipt.details.after,
            );
          if (command.action === "create" && new Set(permissions.editableSettings).size !== 3)
            return yield* Effect.fail(new DomainError({ code: "admin_forbidden" }));
          return { ...receipt.response, replayed: true };
        }
        const details =
          command.action === "create"
            ? yield* createProject(command, permissions)
            : yield* changeProject(command, permissions, yield* projectSnapshot(projectId));
        if (details !== undefined && command.action !== "create")
          yield* sql`UPDATE otp_router.projects SET revision = revision + 1 WHERE id = ${projectId}`;
        const body = yield* projectSnapshot(projectId);
        const eventId = details === undefined ? null : randomUUID();
        if (details !== undefined) {
          const validated = yield* Schema.decodeUnknownEffect(ChangeDetails)(details, {
            onExcessProperty: "error",
          });
          yield* sql`INSERT INTO otp_router.project_admin_events(id,project_id,actor_id,action,revision,details) VALUES (${eventId},${projectId},${actorId},${command.action},${body.revision},${JSON.stringify(validated)}::jsonb)`;
        }
        const response: typeof AdminResult.Type = {
          status: command.action === "create" ? 201 : 200,
          body,
          replayed: false,
        };
        yield* sql`INSERT INTO otp_router.admin_request_receipts(actor_id,key,fingerprint,response,project_id,event_id,retain_until) VALUES (${actorId},${key},${fingerprint},${JSON.stringify(response)}::jsonb,${projectId},${eventId},${command.action === "create" ? sql`NULL` : sql`clock_timestamp() + interval '7 days'`})`;
        return response;
      }),
    );
  });
