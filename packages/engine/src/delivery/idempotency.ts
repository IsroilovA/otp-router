import { findOperation, expire } from "./store.js";
import { databaseTime } from "../database/transaction.js";
import { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import { Digest, digest, equalDigest, operationIdentity, type CryptoConfig } from "../crypto.js";
import { rows } from "../database/query.js";
import { DomainError } from "../errors.js";
import { OperationResult } from "./contracts.js";
export const identity = (
  config: CryptoConfig,
  name: string,
  request: { readonly key: string; readonly operationId?: string },
) =>
  operationIdentity(
    config.deploymentId,
    `delivery:${name}`,
    request.operationId ?? "",
    request.key,
  );
const Record = Schema.Struct({
  operation_id: Schema.String,
  fingerprint: Digest,
  code_fingerprint: Schema.NullOr(Digest),
  response: OperationResult,
});
export const replay = (config: CryptoConfig, id: string, input: object, code?: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))`.pipe(
      Effect.mapError((error) =>
        error.reason._tag === "LockTimeoutError"
          ? new DomainError({ code: "request_in_progress" })
          : error,
      ),
    );
    let record = (yield* rows(
      Record,
      sql`SELECT operation_id,fingerprint,code_fingerprint,response FROM otp_router.delivery_idempotency WHERE identity = ${id}`,
    ))[0];
    if (record === undefined) return undefined;
    const retained = yield* findOperation(record.operation_id, true).pipe(
      Effect.catchTag("DomainError", () => Effect.succeed(undefined)),
    );
    if (retained !== undefined) yield* expire(retained, yield* databaseTime);
    record = (yield* rows(
      Record,
      sql`SELECT operation_id,fingerprint,code_fingerprint,response FROM otp_router.delivery_idempotency WHERE identity = ${id}`,
    ))[0];
    if (record === undefined) return undefined;
    const candidate = digest(
      config.fingerprint,
      [1, "delivery-request", id, input],
      record.fingerprint.keyId,
    );
    if (!equalDigest(candidate.value, record.fingerprint.value))
      return yield* Effect.fail(new DomainError({ code: "idempotency_conflict" }));
    if (
      record.code_fingerprint !== null &&
      !equalDigest(
        digest(
          config.fingerprint,
          [1, "delivery-request-code", id, code],
          record.code_fingerprint.keyId,
        ).value,
        record.code_fingerprint.value,
      )
    )
      return yield* Effect.fail(new DomainError({ code: "idempotency_conflict" }));
    return { ...record.response, replayed: true };
  });
export const save = (
  config: CryptoConfig,
  id: string,
  input: object,
  result: {
    readonly response: OperationResult;
    readonly active: boolean;
    readonly time: Date;
    readonly code?: string;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`INSERT INTO otp_router.delivery_idempotency(identity,fingerprint,code_fingerprint,operation_id,response,created_at,retain_until) VALUES (${id},${sql.json(digest(config.fingerprint, [1, "delivery-request", id, input]))},${result.active && result.code !== undefined ? sql.json(digest(config.fingerprint, [1, "delivery-request-code", id, result.code])) : null},${result.response.body.operationId},${sql.json(result.response)},${result.time},${new Date(result.time.getTime() + 7 * 86400000)})`;
    return result.response;
  });
