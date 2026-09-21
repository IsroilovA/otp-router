import { createHash } from "node:crypto";
import { SqlClient } from "effect/unstable/sql";
import { Effect, Schema } from "effect";
import { ConfigurationError, type Settings } from "../config/config.js";
import { rows } from "./query.js";
export const validateStoredKeys = (settings: Settings) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const references = yield* rows(
      Schema.Struct({
        purpose: Schema.Literals(["encryption", "verification", "fingerprint"]),
        key_id: Schema.String,
      }),
      sql`
    SELECT DISTINCT 'encryption' AS purpose, phone->>'keyId' AS key_id FROM otp_router.delivery_secrets
    UNION SELECT DISTINCT 'encryption', code->>'keyId' FROM otp_router.delivery_secrets WHERE code IS NOT NULL
    UNION SELECT DISTINCT 'verification', verifier->>'keyId' FROM otp_router.challenge_secrets
    UNION SELECT DISTINCT 'fingerprint', code_fingerprint->>'keyId' FROM otp_router.delivery_secrets WHERE code_fingerprint IS NOT NULL
    UNION SELECT DISTINCT 'fingerprint', fingerprint->>'keyId' FROM otp_router.delivery_idempotency
    UNION SELECT DISTINCT 'fingerprint', code_fingerprint->>'keyId' FROM otp_router.delivery_idempotency WHERE code_fingerprint IS NOT NULL
    UNION SELECT DISTINCT 'fingerprint', fingerprint->>'keyId' FROM otp_router.idempotency_records
    UNION SELECT DISTINCT 'fingerprint', code_fingerprint->>'keyId' FROM otp_router.idempotency_records WHERE code_fingerprint IS NOT NULL`,
    );
    for (const reference of references)
      if (settings.crypto[reference.purpose]?.keys[reference.key_id] === undefined)
        return yield* Effect.fail(new ConfigurationError({ reason: "retained_key_missing" }));
    const snapshots = yield* rows(
      Schema.Struct({ version: Schema.String }),
      sql`SELECT DISTINCT snapshot->>'version' AS version FROM otp_router.delivery_operations WHERE state IN ('prepared','active')`,
    );
    if (snapshots.some((snapshot) => snapshot.version !== "1"))
      return yield* Effect.fail(new ConfigurationError({ reason: "unsupported_snapshot_version" }));
  });

export const validateDeploymentIdentity = (settings: Settings, adoptRecipientKey = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "recipient-key-identity",
          settings.crypto.deploymentId,
          settings.crypto.recipientKey,
        ]),
      )
      .digest("hex");
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(715736294139)`;
        const stored = (yield* rows(
          Schema.Struct({ deployment_id: Schema.String, recipient_key_fingerprint: Schema.String }),
          sql`SELECT * FROM otp_router.deployment_identity WHERE singleton = true`,
        ))[0];
        if (stored === undefined) {
          yield* sql`INSERT INTO otp_router.deployment_identity(deployment_id,recipient_key_fingerprint) VALUES (${settings.crypto.deploymentId},${fingerprint})`;
          return;
        }
        if (stored.deployment_id !== settings.crypto.deploymentId)
          return yield* Effect.fail(
            new ConfigurationError({ reason: "deployment_identity_changed" }),
          );
        if (stored.recipient_key_fingerprint === fingerprint) return;
        if (!adoptRecipientKey)
          return yield* Effect.fail(
            new ConfigurationError({ reason: "recipient_key_changed_requires_incident_procedure" }),
          );
        const unsafe = yield* rows(
          Schema.Struct({ blocked: Schema.Boolean }),
          sql`SELECT EXISTS (SELECT 1 FROM otp_router.delivery_operations WHERE state IN ('prepared','active')) OR EXISTS (SELECT 1 FROM otp_router.quota_events WHERE occurred_at > clock_timestamp() - interval '24 hours') AS blocked`,
        );
        if (unsafe[0]?.blocked !== false)
          return yield* Effect.fail(
            new ConfigurationError({
              reason: "recipient_key_change_requires_invalidation_and_quota_wait",
            }),
          );
        yield* sql`UPDATE otp_router.deployment_identity SET recipient_key_fingerprint = ${fingerprint} WHERE singleton = true`;
      }),
    );
  });
