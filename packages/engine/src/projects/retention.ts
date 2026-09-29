import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { rows } from "../database/query.js";
export const cleanupAdminReceipts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* rows(
    Schema.Struct({ deleted: Schema.Int }),
    sql`DELETE FROM otp_router.admin_request_receipts WHERE (actor_id,key) IN (SELECT actor_id,key FROM otp_router.admin_request_receipts WHERE retain_until <= clock_timestamp() LIMIT 1000) RETURNING 1 AS deleted`,
  )).length;
});
