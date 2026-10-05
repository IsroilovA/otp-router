import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { rows } from "../database/query.js";
import { DomainError } from "../errors.js";
import type { ResourceData, ResourceKind, Policy } from "./contracts.js";

export const resourceTable = (kind: typeof ResourceKind.Type) =>
  ({
    account: "otp_router.provider_accounts",
    instance: "otp_router.provider_instances",
    policy: "otp_router.routing_policies",
    scope: "otp_router.allowance_scopes",
  })[kind];

const savePolicy = (id: string, revision: number, policy: Policy) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { providerInstanceIds, manualProviderIds, ...settings } = policy;
    yield* sql`INSERT INTO otp_router.policy_revisions(policy_id,revision,settings) VALUES (${id},${revision},${JSON.stringify(settings)}::jsonb)`;
    for (const [position, instanceId] of providerInstanceIds.entries())
      yield* sql`INSERT INTO otp_router.policy_steps(policy_id,revision,position,instance_id,manual_selection_allowed) VALUES (${id},${revision},${position},${instanceId},${manualProviderIds.includes(instanceId)})`;
  });

export const insertResource = (id: string, data: typeof ResourceData.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const exists = yield* rows(
      Schema.Struct({ id: Schema.String }),
      sql`SELECT id FROM ${sql(resourceTable(data.kind))} WHERE id = ${id}`,
    );
    if (exists.length > 0)
      return yield* Effect.fail(new DomainError({ code: "resource_conflict" }));
    switch (data.kind) {
      case "account":
        yield* sql`INSERT INTO otp_router.provider_accounts(id,adapter_id,schema_version,identity) VALUES (${id},${data.adapterId},${data.schemaVersion},${JSON.stringify(data.identity)}::jsonb)`;
        for (const scope of data.scopeIds)
          yield* sql`INSERT INTO otp_router.account_allowances(account_id,scope_id) VALUES (${id},${scope})`;
        break;
      case "instance":
        yield* sql`INSERT INTO otp_router.provider_instances(id,account_id) VALUES (${id},${data.accountId})`;
        yield* sql`INSERT INTO otp_router.instance_revisions(instance_id,revision,settings) VALUES (${id},1,${JSON.stringify(data.settings)}::jsonb)`;
        for (const scope of data.scopeIds)
          yield* sql`INSERT INTO otp_router.instance_allowances(instance_id,scope_id) VALUES (${id},${scope})`;
        break;
      case "policy":
        yield* sql`INSERT INTO otp_router.routing_policies(id) VALUES (${id})`;
        yield* savePolicy(id, 1, data.settings);
        break;
      case "scope":
        yield* sql`INSERT INTO otp_router.allowance_scopes(id,send_limit_15m,send_limit_24h) VALUES (${id},${data.limits.sendLimit15m},${data.limits.sendLimit24h})`;
        break;
    }
  });

export const saveConfiguration = (
  id: string,
  revision: number,
  data: Exclude<typeof ResourceData.Type, { kind: "account" }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    switch (data.kind) {
      case "instance":
        yield* sql`INSERT INTO otp_router.instance_revisions(instance_id,revision,settings) VALUES (${id},${revision},${JSON.stringify(data.settings)}::jsonb)`;
        yield* sql`UPDATE otp_router.provider_instances SET configuration_revision = ${revision} WHERE id = ${id}`;
        break;
      case "policy":
        yield* savePolicy(id, revision, data.settings);
        yield* sql`UPDATE otp_router.routing_policies SET configuration_revision = ${revision} WHERE id = ${id}`;
        break;
      case "scope":
        yield* sql`UPDATE otp_router.allowance_scopes SET send_limit_15m = ${data.limits.sendLimit15m}, send_limit_24h = ${data.limits.sendLimit24h} WHERE id = ${id}`;
        break;
    }
  });
