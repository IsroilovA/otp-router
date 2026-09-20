import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE otp_router.provider_restrictions(provider_instance_id text PRIMARY KEY,retry_at timestamptz NOT NULL)`;
  yield* sql`CREATE TABLE otp_router.deployment_identity(singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),deployment_id text NOT NULL,recipient_key_fingerprint text NOT NULL)`;
});
