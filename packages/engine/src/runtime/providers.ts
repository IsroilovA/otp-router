import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { RuntimeConfiguration } from "../config/config.js";
import { Ciphertext, type CryptoConfig, decrypt, encrypt } from "../crypto.js";
import { rows } from "../database/query.js";
import { DomainError } from "../errors.js";
import { validateProviderConfiguration } from "../providers/internal.js";
import { ProviderInstance, ProviderInstanceIdSchema } from "../providers/contract.js";
import type { InstanceSettings } from "./contracts.js";
import { type ResourceRecord } from "./store.js";

export const encryptAccountSecret = (
  crypto: CryptoConfig,
  {
    accountId,
    purpose,
    version,
  }: { readonly accountId: string; readonly purpose: string; readonly version: string },
  secret: Schema.Json,
) =>
  encrypt(
    crypto,
    { projectId: `account:${accountId}`, operationId: version },
    `runtime:${purpose}`,
    JSON.stringify(secret),
  );
export const secretVersion = (
  config: RuntimeConfiguration,
  accountId: string,
  purpose: string,
  version: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const record = (yield* rows(
      Schema.Struct({ ciphertext: Ciphertext }),
      sql`SELECT ciphertext FROM otp_router.account_secret_versions WHERE id = ${version} AND account_id = ${accountId} AND purpose = ${purpose} AND NOT revoked AND ciphertext IS NOT NULL`,
    ))[0];
    if (record === undefined)
      return yield* Effect.fail(new DomainError({ code: "delivery_unavailable" }));
    const text = yield* decrypt(
      config.settings.crypto,
      { projectId: `account:${accountId}`, operationId: version },
      `runtime:${purpose}`,
      record.ciphertext,
    );
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text);
  });
export const providerConfiguration = (
  config: RuntimeConfiguration,
  account: ResourceRecord,
  options: {
    readonly instanceId: string;
    readonly revision: number;
    readonly settings: typeof InstanceSettings.Type;
  },
) =>
  Effect.gen(function* () {
    if (account.data.kind !== "account") return yield* Effect.die(new Error("Invalid account"));
    const adapter = config.adapters.get(account.data.adapterId);
    const sendVersion = account.send_version;
    if (
      adapter === undefined ||
      adapter.schemaVersion !== account.data.schemaVersion ||
      sendVersion === null
    )
      return yield* Effect.fail(new DomainError({ code: "delivery_unavailable" }));
    const secrets = yield* secretVersion(config, account.id, "send", sendVersion);
    const prepared = {
      instanceId: yield* Schema.decodeUnknownEffect(ProviderInstanceIdSchema)(options.instanceId),
      revision: String(options.revision),
      identity: account.data.identity,
      secrets,
      execution: options.settings.execution,
      templates: options.settings.templates,
      sendTimeoutMs: options.settings.sendTimeoutMs,
    };
    yield* validateProviderConfiguration(adapter.secretsSchema, secrets).pipe(
      Effect.mapError(() => new DomainError({ code: "delivery_unavailable" })),
    );
    return { definition: adapter, options: prepared };
  });
// Layer resources belong to the caller's preparation/dispatch scope, never a
// scope that ends before template resolution or the committed invocation.
export const constructProvider = (
  prepared: Effect.Success<ReturnType<typeof providerConfiguration>>,
) =>
  Layer.build(prepared.definition.make(prepared.options)).pipe(
    Effect.map((context) => Context.get(context, ProviderInstance)),
    Effect.catchTag("ProviderConfigurationError", () =>
      Effect.fail(new DomainError({ code: "delivery_unavailable" })),
    ),
  );
