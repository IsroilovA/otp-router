import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { rows } from "../database/query.js";
import { DomainError } from "../errors.js";
import { ResourceData, ResourceKind, type ResourceSnapshot, ResourceState } from "./contracts.js";

// Runtime authority precedes project, request identity, sorted quotas, operation, and event locks.
// Shared readers can commit concurrently; administration serializes all authority changes.
export const lockRuntime = (exclusive = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (exclusive) yield* sql`SELECT pg_advisory_xact_lock(715736294142)`;
    else yield* sql`SELECT pg_advisory_xact_lock_shared(715736294142)`;
  });
export const ResourceRecord = Schema.Struct({
  id: Schema.String,
  kind: ResourceKind,
  revision: Schema.Int,
  configuration_revision: Schema.Int,
  epoch: Schema.Int,
  state: Schema.NullOr(ResourceState),
  data: ResourceData,
  send_version: Schema.NullOr(Schema.String),
  callback_version: Schema.NullOr(Schema.String),
});
export type ResourceRecord = typeof ResourceRecord.Type;
export const resource = (kind: typeof ResourceKind.Type, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const value = (yield* rows(
      ResourceRecord,
      sql`SELECT * FROM otp_router.runtime_resources WHERE kind = ${kind} AND id = ${id}`,
    ))[0];
    if (value === undefined)
      return yield* Effect.fail(new DomainError({ code: "resource_not_found" }));
    return value;
  });
export const publicResource = (value: ResourceRecord): typeof ResourceSnapshot.Type => {
  if (value.data.kind === "scope")
    return { id: value.id, revision: value.revision, data: value.data };
  if (value.state === null) throw new Error("Missing resource lifecycle");
  return {
    id: value.id,
    revision: value.revision,
    configurationRevision: value.configuration_revision,
    epoch: value.epoch,
    state: value.state,
    data: value.data,
    sendCredentialVersion: value.send_version,
    callbackVersion: value.callback_version,
  };
};
export const activeGrant = (projectId: string, kind: typeof ResourceKind.Type, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* rows(
      Schema.Struct({ id: Schema.String }),
      sql`SELECT id FROM otp_router.runtime_grants WHERE project_id = ${projectId} AND kind = ${kind} AND resource_id = ${id} AND revoked_at IS NULL`,
    ))[0]?.id;
  });
export const instanceAuthority = (projectId: string, instanceId: string, savedGrantId?: string) =>
  Effect.gen(function* () {
    const instance = yield* resource("instance", instanceId);
    if (instance.data.kind !== "instance")
      return yield* Effect.die(new Error("Invalid resource kind"));
    const account = yield* resource("account", instance.data.accountId);
    const sql = yield* SqlClient.SqlClient;
    const grantId =
      savedGrantId === undefined
        ? ((yield* activeGrant(projectId, "instance", instanceId)) ??
          (yield* activeGrant(projectId, "account", account.id)))
        : (yield* rows(
            Schema.Struct({ id: Schema.String }),
            sql`SELECT id FROM otp_router.runtime_grants WHERE id = ${savedGrantId} AND project_id = ${projectId} AND revoked_at IS NULL AND ((kind = 'instance' AND resource_id = ${instanceId}) OR (kind = 'account' AND resource_id = ${account.id}))`,
          ))[0]?.id;
    return grantId === undefined || instance.state !== "enabled" || account.state !== "enabled"
      ? undefined
      : { instance, account, grantId };
  });
export const revisionValid = (kind: typeof ResourceKind.Type, id: string, revision: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (
      (yield* rows(
        Schema.Struct({ valid: Schema.Boolean }),
        sql`SELECT EXISTS (SELECT 1 FROM otp_router.runtime_revisions WHERE kind = ${kind} AND resource_id = ${id} AND revision = ${revision} AND NOT invalidated) AS valid`,
      ))[0]?.valid === true
    );
  });
export const Authority = Schema.Struct({
  policyGrantId: Schema.String,
  policyEpoch: Schema.Int,
  steps: Schema.Array(
    Schema.Struct({
      instanceId: Schema.String,
      accountEpoch: Schema.Int,
      instanceEpoch: Schema.Int,
      grantId: Schema.String,
    }),
  ),
});
export const captureAuthority = (
  projectId: string,
  policyId: string,
  instances: readonly string[],
) =>
  Effect.gen(function* () {
    const policy = yield* resource("policy", policyId);
    const policyGrantId = yield* activeGrant(projectId, "policy", policyId);
    if (policy.state !== "enabled" || policyGrantId === undefined)
      return yield* Effect.fail(new DomainError({ code: "policy_not_allowed" }));
    const steps = [];
    for (const instanceId of instances) {
      const authority = yield* instanceAuthority(projectId, instanceId);
      if (authority !== undefined)
        steps.push({
          instanceId,
          accountEpoch: authority.account.epoch,
          instanceEpoch: authority.instance.epoch,
          grantId: authority.grantId,
        });
    }
    return { policyGrantId, policyEpoch: policy.epoch, steps };
  });
export const intentRuntimeAuthority = (intentId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* rows(
      Schema.Struct({ authority: Authority }),
      sql`SELECT authority FROM otp_router.send_intents WHERE id = ${intentId}`,
    ))[0]?.authority;
  });
