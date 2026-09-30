import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ConfigurationError, type RuntimeConfiguration } from "../config/config.js";
import { rows } from "../database/query.js";
import { ResourceData } from "../runtime/contracts.js";
import { validateJson } from "../runtime/validation.js";
import { resource } from "../runtime/store.js";
import { lockRuntime } from "../runtime/store.js";

const incompatible = () => new ConfigurationError({ reason: "incompatible_capabilities" });
export const validateCapabilities = (config: RuntimeConfiguration) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fingerprint = config.capabilityFingerprint;
    const connection = yield* sql.reserve;
    yield* Effect.addFinalizer(() =>
      connection
        .executeValues("SELECT pg_advisory_unlock_all()", [])
        .pipe(Effect.orDie, Effect.asVoid),
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(715736294140)`;
        const exclusive = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Tuple([Schema.Boolean])),
        )(yield* connection.executeValues("SELECT pg_try_advisory_lock(715736294141)", []));
        if (exclusive[0]?.[0] === true) {
          yield* sql`INSERT INTO otp_router.deployment_capabilities(singleton,fingerprint) VALUES (true,${fingerprint}) ON CONFLICT (singleton) DO UPDATE SET fingerprint = EXCLUDED.fingerprint`;
          yield* connection.executeValues("SELECT pg_advisory_lock_shared(715736294141)", []);
          yield* connection.executeValues("SELECT pg_advisory_unlock(715736294141)", []);
        } else {
          yield* assertCapabilities(config);
          yield* connection.executeValues("SELECT pg_advisory_lock_shared(715736294141)", []);
        }
        const retained = yield* rows(
          Schema.Struct({ data: ResourceData }),
          sql`SELECT v.data FROM otp_router.runtime_revisions v JOIN otp_router.runtime_resources r ON r.kind = v.kind AND r.id = v.resource_id
          WHERE (r.state <> 'retired' AND v.revision = r.configuration_revision)
          OR EXISTS (SELECT 1 FROM otp_router.operation_route_steps s WHERE (v.kind = 'instance' AND s.provider_instance_id = v.resource_id AND s.instance_revision = v.revision) OR (v.kind = 'account' AND s.account_id = v.resource_id))
          OR EXISTS (SELECT 1 FROM otp_router.delivery_operations o WHERE v.kind = 'policy' AND o.policy_id = v.resource_id AND o.policy_revision = v.revision)
          OR EXISTS (SELECT 1 FROM otp_router.callback_inbox i JOIN otp_router.provider_instances instance ON instance.id = i.provider_instance_id WHERE (v.kind = 'instance' AND v.resource_id = instance.id AND i.instance_revisions @> jsonb_build_array(v.revision)) OR (v.kind = 'account' AND v.resource_id = instance.account_id))`,
        );
        for (const { data } of retained)
          yield* validateRetainedData(config, data).pipe(Effect.mapError(incompatible));
        const invalid = yield* rows(
          Schema.Struct({ invalid: Schema.Boolean }),
          sql`SELECT
      EXISTS (SELECT 1 FROM otp_router.project_principal_grants WHERE revoked_at IS NULL AND principal_id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(config.settings.administration.principalIds)}::jsonb)))
      OR (${config.authorizer === undefined} AND (EXISTS (SELECT 1 FROM otp_router.projects WHERE authorization_required) OR EXISTS (SELECT 1 FROM otp_router.delivery_operations WHERE authorization_required AND state IN ('prepared','active'))))
      OR (${config.settings.administration.authorizationFloor} AND EXISTS (SELECT 1 FROM otp_router.projects WHERE NOT authorization_required)) AS invalid`,
        );
        if (invalid[0]?.invalid !== false) return yield* Effect.fail(incompatible());
      }),
    );
  });
// A process that lost its registration connection cannot keep using an obsolete capability contract.
export const assertCapabilities = (config: RuntimeConfiguration, exclusiveRuntime = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT pg_advisory_xact_lock_shared(715736294141)`;
    yield* lockRuntime(exclusiveRuntime);
    const stored = yield* rows(
      Schema.Struct({ fingerprint: Schema.String }),
      sql`SELECT fingerprint FROM otp_router.deployment_capabilities WHERE singleton`,
    );
    if (stored[0]?.fingerprint !== config.capabilityFingerprint)
      return yield* Effect.fail(incompatible());
  });

const validateRetainedData = (config: RuntimeConfiguration, data: typeof ResourceData.Type) =>
  Effect.gen(function* () {
    if (data.kind === "policy") {
      if (
        data.settings.selectorId !== undefined &&
        config.selectors[data.settings.selectorId] === undefined
      )
        return yield* Effect.fail(incompatible());
      return;
    }
    if (data.kind === "scope") return;
    const account =
      data.kind === "account" ? data : (yield* resource("account", data.accountId)).data;
    if (account.kind !== "account") return yield* Effect.fail(incompatible());
    const adapter = config.adapters.get(account.adapterId);
    if (adapter === undefined || adapter.schemaVersion !== account.schemaVersion)
      return yield* Effect.fail(incompatible());
    yield* validateJson(adapter.identitySchema, account.identity);
    if (data.kind === "instance") {
      yield* validateJson(adapter.executionSchema, data.settings.execution);
      if (adapter.templateSchema !== null)
        for (const template of Object.values(data.settings.templates))
          yield* validateJson(adapter.templateSchema, template);
    }
  });
