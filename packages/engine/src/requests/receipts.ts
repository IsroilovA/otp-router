import { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import { Digest } from "../crypto.js";
import { rows, single } from "../database/query.js";

const Response = Schema.Struct({ outcome: Schema.String, body: Schema.Unknown });
const Receipt = Schema.Struct({
  operation_id: Schema.String,
  fingerprint: Digest,
  code_fingerprint: Schema.NullOr(Digest),
  response: Response,
});
type Capability = "managed" | "external";
export const readReceipt = (identity: string, capability: Capability) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return (yield* rows(
      Receipt,
      sql`SELECT operation_id,fingerprint,code_fingerprint,response FROM otp_router.request_receipts WHERE identity = ${identity} AND capability = ${capability}`,
    ))[0];
  });
export const saveReceipt = (receipt: {
  readonly identity: string;
  readonly capability: Capability;
  readonly operationId: string;
  readonly fingerprint: Digest;
  readonly codeFingerprint: Digest | null;
  readonly response: typeof Response.Type;
  readonly time: Date;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const retainUntil = new Date(
      receipt.time.getTime() + (receipt.capability === "external" ? 7 : 1) * 86400000,
    );
    yield* single(
      Schema.Struct({ identity: Schema.String }),
      sql`INSERT INTO otp_router.request_receipts(identity,capability,project_id,operation_id,fingerprint,code_fingerprint,response,created_at,retain_until)
    SELECT ${receipt.identity},${receipt.capability},project_id,id,${sql.json(receipt.fingerprint)},${receipt.codeFingerprint === null ? null : sql.json(receipt.codeFingerprint)},${sql.json(receipt.response)},${receipt.time},${retainUntil}
    FROM otp_router.delivery_operations WHERE id = ${receipt.operationId} RETURNING identity`,
    );
  });
