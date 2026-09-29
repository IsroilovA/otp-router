import { readReceipt, saveReceipt } from "../requests/receipts.js";
import { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import { single } from "../database/query.js";
import { databaseTime } from "../database/transaction.js";
import { type OperationResult } from "./contracts.js";
import { DomainError } from "../errors.js";
import { digest, equalDigest, operationIdentity, type CryptoConfig } from "../crypto.js";
import { expire, findChallenge } from "./store.js";

export interface Operation {
  readonly identity: string;
  readonly input: object;
  readonly code?: string;
  readonly challengeId?: string;
}
export const operation = (
  config: CryptoConfig,
  request: {
    readonly projectId: string;
    readonly key: string;
    readonly input: object;
    readonly challengeId?: string;
  },
  name: string,
): Operation => ({
  identity: operationIdentity(config.deploymentId, request.projectId, {
    name: name,
    target: request.challengeId ?? "",
    key: request.key,
  }),
  input: request.input,
  ...(request.challengeId === undefined ? {} : { challengeId: request.challengeId }),
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
export const replay = <S extends Schema.Top>(config: CryptoConfig, op: Operation, schema: S) =>
  Effect.gen(function* () {
    let record = yield* readReceipt(op.identity, "managed");
    if (record === undefined) return undefined;
    if (op.challengeId !== undefined) {
      const maybe = yield* findChallenge(op.challengeId, true).pipe(
        Effect.catchTag("DomainError", () => Effect.succeed(undefined)),
      );
      if (maybe !== undefined) yield* expire(maybe, yield* databaseTime);
      record = yield* readReceipt(op.identity, "managed");
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
    return yield* Schema.decodeUnknownEffect(schema)({ ...record.response, replayed: true });
  });
export const saveResult = <A extends OperationResult>(
  config: CryptoConfig,
  op: Operation,
  result: {
    readonly challengeId: string;
    readonly response: A;
    readonly active: boolean;
    readonly time: Date;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const owner = yield* single(
      Schema.Struct({ operation_id: Schema.String }),
      sql`SELECT operation_id FROM otp_router.challenges WHERE id = ${result.challengeId}`,
    );
    yield* saveReceipt({
      identity: op.identity,
      capability: "managed",
      operationId: owner.operation_id,
      fingerprint: digest(config.fingerprint, fingerprintInput(config, op)),
      codeFingerprint:
        op.code !== undefined && result.active
          ? digest(config.fingerprint, codeInput(config, op))
          : null,
      response: { outcome: result.response.outcome, body: result.response.body },
      time: result.time,
    });
    return result.response;
  });
