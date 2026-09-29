import { readReceipt, saveReceipt } from "../requests/receipts.js";
import { findOperation, expire } from "./store.js";
import { databaseTime } from "../database/transaction.js";
import { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import { digest, equalDigest, operationIdentity, type CryptoConfig } from "../crypto.js";
import { DomainError } from "../errors.js";
import { OperationResult } from "./contracts.js";
export const identity = (
  config: CryptoConfig,
  name: string,
  request: { readonly projectId: string; readonly key: string; readonly operationId?: string },
) =>
  operationIdentity(config.deploymentId, request.projectId, {
    name: `delivery:${name}`,
    target: request.operationId ?? "",
    key: request.key,
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
    let record = yield* readReceipt(id, "external");
    if (record === undefined) return undefined;
    const retained = yield* findOperation(record.operation_id, true).pipe(
      Effect.catchTag("DomainError", () => Effect.succeed(undefined)),
    );
    if (retained !== undefined) yield* expire(retained, yield* databaseTime);
    record = yield* readReceipt(id, "external");
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
    return yield* Schema.decodeUnknownEffect(OperationResult)({
      ...record.response,
      replayed: true,
    });
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
    yield* saveReceipt({
      identity: id,
      capability: "external",
      operationId: result.response.body.operationId,
      fingerprint: digest(config.fingerprint, [1, "delivery-request", id, input]),
      codeFingerprint:
        result.active && result.code !== undefined
          ? digest(config.fingerprint, [1, "delivery-request-code", id, result.code])
          : null,
      response: { outcome: result.response.outcome, body: result.response.body },
      time: result.time,
    });
    return result.response;
  });
