import { changed } from "./changes.js";
import { SqlClient } from "effect/unstable/sql";
import { Effect, Schema } from "effect";
import { rows, single } from "../database/query.js";
import { Operation, Attempt, Secrets } from "./records.js";
import { DomainError } from "../errors.js";

export const findOperation = (id: string, lock = false) =>
  Effect.gen(function* () {
    if (!Schema.is(Schema.String.check(Schema.isUUID()))(id))
      return yield* Effect.fail(new DomainError({ code: "operation_not_found" }));
    const sql = yield* SqlClient.SqlClient;
    const values = yield* rows(
      Operation,
      lock
        ? sql`SELECT * FROM otp_router.delivery_operations WHERE id = ${id} FOR UPDATE`
        : sql`SELECT * FROM otp_router.delivery_operations WHERE id = ${id}`,
    );
    const operation = values[0];
    if (operation === undefined)
      return yield* Effect.fail(new DomainError({ code: "operation_not_found" }));
    return operation;
  });
export const findAttempt = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* single(Attempt, sql`SELECT * FROM otp_router.delivery_attempts WHERE id = ${id}`);
  });
export const findSecrets = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* single(
      Secrets,
      sql`SELECT * FROM otp_router.delivery_secrets WHERE operation_id = ${id}`,
    );
  });
export const eraseSecrets = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Provider inputs are already in memory after the gate. No later operation needs this row.
    yield* sql`DELETE FROM otp_router.delivery_secrets WHERE operation_id = ${id}`;
    yield* sql`UPDATE otp_router.delivery_idempotency SET code_fingerprint = NULL WHERE operation_id = ${id} AND code_fingerprint IS NOT NULL`;
    yield* sql`UPDATE otp_router.delivery_attempts SET state = 'suppressed' WHERE operation_id = ${id} AND state = 'pending'`;
  });
export const terminate = (operation: Operation, state: "closed" | "expired", time: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE otp_router.delivery_operations SET state = ${state}, terminal_at = ${time}, routing_revision = routing_revision + 1, automatic_stopped = true WHERE id = ${operation.id} AND state IN ('prepared','active')`;
    yield* eraseSecrets(operation.id);
    yield* changed(operation.id);
    return yield* findOperation(operation.id);
  });
export const expire = (operation: Operation, time: Date) =>
  (operation.state === "prepared" || operation.state === "active") && time >= operation.expires_at
    ? terminate(operation, "expired", time)
    : Effect.succeed(operation);
export const requireActive = (operation: Operation) =>
  operation.state === "active"
    ? Effect.void
    : Effect.fail(new DomainError({ code: "operation_unavailable" }));
export const requireExternal = (operation: Operation) =>
  operation.owner === "external"
    ? Effect.void
    : Effect.fail(new DomainError({ code: "managed_operation" }));

export const invalidRecipient = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* single(
      Schema.Struct({ stopped: Schema.Boolean }),
      sql`SELECT EXISTS (SELECT 1 FROM otp_router.delivery_attempts WHERE operation_id = ${id} AND failure_category = 'InvalidRecipient') AS stopped`,
    )).stopped;
  });
