import { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import { rows } from "../database/query.js";
import { databaseTime } from "../database/transaction.js";
import { DomainError, OperationOutcome, ResultBody, OperationResult } from "./contracts.js";
import { Digest, digest, equalDigest, operationIdentity, type CryptoConfig } from "./crypto.js";
import { expire, findChallenge } from "./store.js";

export interface Operation {
  readonly identity: string;
  readonly input: object;
  readonly code?: string;
  readonly challengeId?: string;
}
export const operation = (
  config: CryptoConfig,
  request: { readonly key: string; readonly input: object; readonly challengeId?: string },
  name: string,
): Operation => ({
  identity: operationIdentity(config.deploymentId, name, request.challengeId ?? "", request.key),
  input: request.input,
  ...(request.challengeId === undefined ? {} : { challengeId: request.challengeId }),
});
const RecordSchema = Schema.Struct({
  identity: Schema.String,
  fingerprint: Digest,
  code_fingerprint: Schema.NullOr(Digest),
  challenge_id: Schema.String,
  response: ResultBody,
  outcome: OperationOutcome,
});
export const lockOperation = (op: Operation) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    // hashtextextended collisions serialize operations, but cannot merge their SHA-256 identities.
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${op.identity},0))`.pipe(
      Effect.mapError((error) =>
        error.reason._tag === "LockTimeoutError"
          ? new DomainError({ code: "request_in_progress" })
          : error,
      ),
    );
  });
const fingerprintInput = (config: CryptoConfig, op: Operation) => [
  1,
  "request",
  config.deploymentId,
  op.identity,
  op.input,
];
const codeInput = (config: CryptoConfig, op: Operation) => [
  1,
  "request-code",
  config.deploymentId,
  op.identity,
  op.code,
];
export const replay = (config: CryptoConfig, op: Operation) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    let record = (yield* rows(
      RecordSchema,
      sql`SELECT * FROM otp_router.idempotency_records WHERE identity = ${op.identity}`,
    ))[0];
    if (record === undefined) return undefined;
    if (op.challengeId !== undefined) {
      const maybe = yield* findChallenge(op.challengeId, true).pipe(
        Effect.catchTag("DomainError", () => Effect.succeed(undefined)),
      );
      if (maybe !== undefined) yield* expire(maybe, yield* databaseTime);
      record = (yield* rows(
        RecordSchema,
        sql`SELECT * FROM otp_router.idempotency_records WHERE identity = ${op.identity}`,
      ))[0];
      if (record === undefined) return undefined;
    }
    const nonCode = digest(
      config.fingerprint,
      fingerprintInput(config, op),
      record.fingerprint.keyId,
    );
    if (!equalDigest(nonCode.value, record.fingerprint.value))
      return yield* Effect.fail(new DomainError({ code: "idempotency_conflict" }));
    if (record.code_fingerprint !== null) {
      const code = digest(config.fingerprint, codeInput(config, op), record.code_fingerprint.keyId);
      if (!equalDigest(code.value, record.code_fingerprint.value))
        return yield* Effect.fail(new DomainError({ code: "idempotency_conflict" }));
    }
    return yield* Schema.decodeUnknownEffect(OperationResult)({
      outcome: record.outcome,
      body: record.response,
      replayed: true,
    });
  });
export const saveResult = (
  config: CryptoConfig,
  op: Operation,
  result: {
    readonly challengeId: string;
    readonly response: OperationResult;
    readonly active: boolean;
    readonly time: Date;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const codeFingerprint =
      op.code !== undefined && result.active
        ? sql.json(digest(config.fingerprint, codeInput(config, op)))
        : null;
    yield* sql`INSERT INTO otp_router.idempotency_records(identity,fingerprint,code_fingerprint,challenge_id,response,outcome,created_at,retain_until) VALUES (${op.identity},${sql.json(digest(config.fingerprint, fingerprintInput(config, op)))},${codeFingerprint},${result.challengeId},${sql.json(result.response.body)},${result.response.outcome},${result.time},${new Date(result.time.getTime() + 86400000)})`;
    return result.response;
  });
