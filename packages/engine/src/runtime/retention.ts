import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { RuntimeConfiguration } from "../config/config.js";
import { assertCapabilities } from "../config/deployment.js";
import { transaction } from "../database/transaction.js";
import { DomainError } from "../errors.js";

// Retain secret-free version identities and all audit. Callback retention follows the
// retained operation/correlation window, including extensions from late evidence.
export const cleanupRuntimeSecrets = (config: RuntimeConfiguration) =>
  transaction(
    Effect.gen(function* () {
      yield* assertCapabilities(config, true).pipe(
        Effect.mapError(() => new DomainError({ code: "temporarily_unavailable" })),
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE otp_router.account_secret_versions v SET ciphertext = NULL WHERE v.ciphertext IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM otp_router.provider_accounts a JOIN otp_router.account_current_secrets c ON c.account_id = a.id WHERE a.state <> 'retired' AND c.version_id = v.id)
    AND ((v.purpose = 'send' AND NOT EXISTS (SELECT 1 FROM otp_router.delivery_attempts a WHERE a.credential_version_id = v.id AND a.state = 'dispatching'))
      OR (v.purpose = 'callback' AND (v.revoked OR (NOT EXISTS (SELECT 1 FROM otp_router.operation_route_steps s WHERE s.account_id = v.account_id)
        AND NOT EXISTS (SELECT 1 FROM otp_router.callback_inbox i JOIN otp_router.provider_instances r ON r.id = i.provider_instance_id WHERE r.account_id = v.account_id)))))`;
    }),
  );
