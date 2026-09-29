import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ConfigurationError, type RuntimeConfiguration } from "../config/config.js";
import { rows } from "../database/query.js";

const incompatible = () => new ConfigurationError({ reason: "incompatible_catalog" });
export const validateCatalog = (config: RuntimeConfiguration) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fingerprint = config.catalogFingerprint;
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
          yield* sql`INSERT INTO otp_router.configured_catalog(singleton,fingerprint) VALUES (true,${fingerprint}) ON CONFLICT (singleton) DO UPDATE SET fingerprint = EXCLUDED.fingerprint`;
          yield* connection.executeValues("SELECT pg_advisory_lock_shared(715736294141)", []);
          yield* connection.executeValues("SELECT pg_advisory_unlock(715736294141)", []);
        } else {
          yield* assertCatalog(config);
          yield* connection.executeValues("SELECT pg_advisory_lock_shared(715736294141)", []);
        }
        const invalid = yield* rows(
          Schema.Struct({ invalid: Schema.Boolean }),
          sql`SELECT
      EXISTS (SELECT 1 FROM otp_router.project_principal_grants WHERE revoked_at IS NULL AND NOT (principal_id = ANY(${[...config.settings.administration.principalIds]}::text[])))
      OR (${config.authorizer === undefined} AND (EXISTS (SELECT 1 FROM otp_router.projects WHERE authorization_required) OR EXISTS (SELECT 1 FROM otp_router.delivery_operations WHERE authorization_required AND state IN ('prepared','active'))))
      OR (${config.settings.administration.authorizationFloor} AND EXISTS (SELECT 1 FROM otp_router.projects WHERE NOT authorization_required)) AS invalid`,
        );
        if (invalid[0]?.invalid !== false) return yield* Effect.fail(incompatible());
      }),
    );
  });
// A process that lost its registration connection cannot keep using an obsolete catalog.
export const assertCatalog = (config: RuntimeConfiguration) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT pg_advisory_xact_lock_shared(715736294141)`;
    const stored = yield* rows(
      Schema.Struct({ fingerprint: Schema.String }),
      sql`SELECT fingerprint FROM otp_router.configured_catalog WHERE singleton`,
    );
    if (stored[0]?.fingerprint !== config.catalogFingerprint)
      return yield* Effect.fail(incompatible());
  });
