import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { RuntimeConfiguration } from "../config/config.js";
import { assertCapabilities } from "../config/deployment.js";
import { canonical, Digest, digest, equalDigest } from "../crypto.js";
import { rows } from "../database/query.js";
import { transaction } from "../database/transaction.js";
import { DomainError } from "../errors.js";
import { scoped } from "../projects/permissions.js";
import { findProject, lockProject } from "../projects/store.js";
import {
  type ResourceData,
  type ResourceKind,
  type RuntimeCommand,
  type RuntimePermission,
  RuntimeRequest,
  RuntimeResult,
} from "./contracts.js";
import { encryptAccountSecret } from "./providers.js";
import { publicResource, type ResourceRecord, resource } from "./store.js";
import {
  invalidRuntime,
  updatedData,
  validateData,
  validateEnable,
  validateJson,
} from "./validation.js";

export const runtimeScoped = (
  permissions: RuntimeConfiguration["settings"]["administration"]["administrators"][string],
  id: string,
) =>
  permissions.resourceIds.includes(id) ||
  permissions.resourcePrefixes.some((prefix) => id.startsWith(prefix));
export const authorizeRuntime = (
  config: RuntimeConfiguration,
  actorId: string,
  permission: typeof RuntimePermission.Type,
  id?: string,
) =>
  Effect.gen(function* () {
    const permissions = config.settings.administration.administrators[actorId];
    if (
      permissions === undefined ||
      !permissions.runtimeActions.includes(permission) ||
      (id !== undefined && !runtimeScoped(permissions, id))
    )
      return yield* Effect.fail(new DomainError({ code: "admin_forbidden" }));
    return permissions;
  });
const commandPermission = (command: typeof RuntimeCommand.Type): typeof RuntimePermission.Type => {
  if (command.action === "grant" || command.action === "revoke") return "assign";
  if (command.action === "rotate" || command.action === "revoke-secret") return "rotate";
  return (command.action === "create" ? command.data.kind : command.kind) === "policy"
    ? "policy"
    : "manage";
};
const insertResource = (id: string, data: typeof ResourceData.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const exists = yield* rows(
      Schema.Struct({ id: Schema.String }),
      sql`SELECT id FROM otp_router.runtime_resources WHERE kind = ${data.kind} AND id = ${id}`,
    );
    if (exists.length > 0)
      return yield* Effect.fail(new DomainError({ code: "resource_conflict" }));
    yield* sql`INSERT INTO otp_router.runtime_resources(kind,id,data) VALUES (${data.kind},${id},${JSON.stringify(data)}::jsonb)`;
  });
const updateResource = (
  config: RuntimeConfiguration,
  command: Extract<typeof RuntimeCommand.Type, { action: "update" }>,
  before: ResourceRecord,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (before.state === "retired") return yield* Effect.fail(invalidRuntime());
    const data = yield* updatedData(before, command.settings);
    yield* validateData(config, data);
    if (canonical(data) === canonical(before.data)) return false;
    yield* sql`UPDATE otp_router.runtime_resources SET data = ${JSON.stringify(data)}::jsonb, configuration_revision = revision + 1 WHERE kind = ${before.kind} AND id = ${before.id}`;
    return true;
  });
const transitionResource = (
  config: RuntimeConfiguration,
  command: Extract<typeof RuntimeCommand.Type, { action: "lifecycle" }>,
  before: ResourceRecord,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (before.state === command.state) return false;
    if (before.state === "retired") return yield* Effect.fail(invalidRuntime());
    if (command.state === "enabled") yield* validateEnable(config, before);
    yield* sql`UPDATE otp_router.runtime_resources SET state = ${command.state}, epoch = epoch + ${command.state === "enabled" ? 0 : 1} WHERE kind = ${before.kind} AND id = ${before.id}`;
    return true;
  });
const rotateSecret = (
  config: RuntimeConfiguration,
  command: Extract<typeof RuntimeCommand.Type, { action: "rotate" }>,
  before: ResourceRecord,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (before.data.kind !== "account" || before.state === "retired")
      return yield* Effect.fail(invalidRuntime());
    const adapter = config.adapters.get(before.data.adapterId);
    if (adapter === undefined) return yield* Effect.fail(invalidRuntime());
    yield* validateJson(
      command.purpose === "send" ? adapter.secretsSchema : adapter.callbackSecretsSchema,
      command.secrets,
    );
    const id = randomUUID();
    const encrypted = encryptAccountSecret(
      config.settings.crypto,
      { accountId: before.id, purpose: command.purpose, version: id },
      command.secrets,
    );
    yield* sql`INSERT INTO otp_router.account_secret_versions(id,account_id,purpose,ciphertext) VALUES (${id},${before.id},${command.purpose},${JSON.stringify(encrypted)}::jsonb)`;
    if (command.purpose === "send")
      yield* sql`UPDATE otp_router.runtime_resources SET send_version = ${id} WHERE kind = 'account' AND id = ${before.id}`;
    else
      yield* sql`UPDATE otp_router.runtime_resources SET callback_version = ${id} WHERE kind = 'account' AND id = ${before.id}`;
    return true;
  });
const revokeSecret = (
  command: Extract<typeof RuntimeCommand.Type, { action: "revoke-secret" }>,
  before: ResourceRecord,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (before.kind !== "account") return yield* Effect.fail(invalidRuntime());
    const changed = yield* rows(
      Schema.Struct({ id: Schema.String }),
      sql`UPDATE otp_router.account_secret_versions SET revoked = true WHERE account_id = ${before.id} AND id = ${command.versionId} AND purpose = 'callback' AND NOT revoked RETURNING id`,
    );
    if (changed.length === 0) return false;
    if (before.callback_version === command.versionId)
      yield* sql`UPDATE otp_router.runtime_resources SET callback_version = NULL WHERE kind = 'account' AND id = ${before.id}`;
    return true;
  });
const invalidateRevision = (
  command: Extract<typeof RuntimeCommand.Type, { action: "invalidate" }>,
  before: ResourceRecord,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (before.kind !== "instance" && before.kind !== "policy")
      return yield* Effect.fail(invalidRuntime());
    const changed = yield* rows(
      Schema.Struct({ revision: Schema.Int }),
      sql`UPDATE otp_router.runtime_revisions SET invalidated = true WHERE kind = ${before.kind} AND resource_id = ${before.id} AND revision = ${command.revision} AND NOT invalidated RETURNING revision`,
    );
    return changed.length > 0;
  });
const changeAssignment = (
  command: Extract<typeof RuntimeCommand.Type, { action: "grant" | "revoke" }>,
  before: ResourceRecord,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (
      before.kind === "scope" ||
      (command.action === "grant" && before.kind === "account" && command.allInstances !== true)
    )
      return yield* Effect.fail(invalidRuntime());
    yield* findProject(command.projectId);
    const grant = (yield* rows(
      Schema.Struct({ id: Schema.String }),
      sql`SELECT id FROM otp_router.runtime_grants WHERE project_id = ${command.projectId} AND kind = ${before.kind} AND resource_id = ${before.id} AND revoked_at IS NULL`,
    ))[0];
    if (command.action === "grant") {
      if (before.state === "retired") return yield* Effect.fail(invalidRuntime());
      if (grant !== undefined) return false;
      yield* sql`INSERT INTO otp_router.runtime_grants(id,project_id,kind,resource_id) VALUES (${randomUUID()},${command.projectId},${before.kind},${before.id})`;
    } else {
      if (grant === undefined) return false;
      yield* sql`UPDATE otp_router.runtime_grants SET revoked_at = clock_timestamp() WHERE id = ${grant.id}`;
    }
    return true;
  });
const changeResource = (
  config: RuntimeConfiguration,
  command: Exclude<typeof RuntimeCommand.Type, { action: "create" }>,
  before: ResourceRecord,
) =>
  Effect.gen(function* () {
    if (before.revision !== command.expectedRevision)
      return yield* Effect.fail(new DomainError({ code: "revision_conflict" }));
    switch (command.action) {
      case "update": {
        return yield* updateResource(config, command, before);
      }
      case "lifecycle": {
        return yield* transitionResource(config, command, before);
      }
      case "rotate": {
        return yield* rotateSecret(config, command, before);
      }
      case "revoke-secret": {
        return yield* revokeSecret(command, before);
      }
      case "invalidate": {
        return yield* invalidateRevision(command, before);
      }
      case "grant":
      case "revoke": {
        return yield* changeAssignment(command, before);
      }
    }
  });
export const mutateRuntime = (config: RuntimeConfiguration, input: typeof RuntimeRequest.Type) =>
  Effect.gen(function* () {
    const { actorId, key, command } = yield* Schema.decodeUnknownEffect(RuntimeRequest)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(invalidRuntime));
    const permissions = yield* authorizeRuntime(
      config,
      actorId,
      commandPermission(command),
      command.id,
    );
    if (
      command.action === "create" &&
      command.firstInstance !== undefined &&
      !runtimeScoped(permissions, command.firstInstance.id)
    )
      return yield* Effect.fail(new DomainError({ code: "admin_forbidden" }));
    if (command.action === "create" && command.data.kind === "instance")
      yield* authorizeRuntime(config, actorId, "manage", command.data.accountId);
    if (
      command.action === "create" &&
      (command.data.kind === "account" || command.data.kind === "instance")
    )
      for (const id of [...command.data.scopeIds, ...(command.firstInstance?.scopeIds ?? [])])
        yield* authorizeRuntime(config, actorId, "manage", id);
    const projectId =
      command.action === "grant" || command.action === "revoke" ? command.projectId : null;
    if (projectId !== null && !scoped(permissions, projectId))
      return yield* Effect.fail(new DomainError({ code: "admin_forbidden" }));
    const kind = command.action === "create" ? command.data.kind : command.kind;
    const sql = yield* SqlClient.SqlClient;
    return yield* transaction(
      Effect.gen(function* () {
        yield* assertCapabilities(config, true);
        if (projectId !== null) yield* lockProject(projectId, true);
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${canonical(["runtime-admin", actorId, key])},0))`;
        const previous = (yield* rows(
          Schema.Struct({ fingerprint: Digest, response: RuntimeResult }),
          sql`SELECT fingerprint,response FROM otp_router.runtime_receipts WHERE actor_id = ${actorId} AND key = ${key}`,
        ))[0];
        const fingerprint = digest(
          config.settings.crypto.fingerprint,
          ["runtime-administration", config.settings.crypto.deploymentId, command],
          previous?.fingerprint.keyId,
        );
        if (previous !== undefined) {
          if (!equalDigest(previous.fingerprint.value, fingerprint.value))
            return yield* Effect.fail(new DomainError({ code: "idempotency_conflict" }));
          return { ...previous.response, replayed: true };
        }
        let changed: boolean;
        if (command.action === "create") {
          yield* validateData(config, command.data);
          yield* insertResource(command.id, command.data);
          if (command.firstInstance !== undefined) {
            if (command.data.kind !== "account") return yield* Effect.fail(invalidRuntime());
            const first = command.firstInstance;
            const data = {
              kind: "instance" as const,
              accountId: command.id,
              settings: first.settings,
              scopeIds: first.scopeIds,
            };
            yield* validateData(config, data);
            yield* insertResource(first.id, data);
            yield* saveRevision("instance", first.id);
            yield* sql`INSERT INTO otp_router.runtime_events(id,actor_id,action,kind,resource_id,revision) VALUES (${randomUUID()},${actorId},'create','instance',${first.id},1)`;
          }
          changed = true;
        } else {
          changed = yield* changeResource(config, command, yield* resource(kind, command.id));
          if (changed)
            yield* sql`UPDATE otp_router.runtime_resources SET revision = revision + 1 WHERE kind = ${kind} AND id = ${command.id}`;
        }
        if (changed) {
          if (command.action === "create" || command.action === "update")
            yield* saveRevision(kind, command.id);
          const current = yield* resource(kind, command.id);
          yield* sql`INSERT INTO otp_router.runtime_events(id,actor_id,action,kind,resource_id,revision,project_id) VALUES (${randomUUID()},${actorId},${command.action},${kind},${command.id},${current.revision},${projectId})`;
        }
        const response = {
          body: publicResource(yield* resource(kind, command.id)),
          replayed: false,
        };
        yield* sql`INSERT INTO otp_router.runtime_receipts(actor_id,key,fingerprint,response) VALUES (${actorId},${key},${JSON.stringify(fingerprint)}::jsonb,${JSON.stringify(response)}::jsonb)`;
        return response;
      }),
    );
  });
const saveRevision = (kind: typeof ResourceKind.Type, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO otp_router.runtime_revisions(kind,resource_id,revision,data) SELECT kind,id,revision,data FROM otp_router.runtime_resources WHERE kind = ${kind} AND id = ${id}`;
  });
