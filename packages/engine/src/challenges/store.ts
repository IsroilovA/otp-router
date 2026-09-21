import { SqlClient } from "effect/unstable/sql";
import { Effect, Schema } from "effect";
import { rows, single } from "../database/query.js";
import { DomainError } from "../errors.js";
import { findOperation, terminate as closeOperation } from "../delivery/store.js";
import { Challenge, Secrets } from "./records.js";
const { delivery: _delivery, ...fields } = Challenge.fields;
const Record = Schema.Struct(fields);
export const findChallenge = (id: string, lock = false) =>
  Effect.gen(function* () {
    if (!Schema.is(Schema.String.check(Schema.isUUID()))(id))
      return yield* Effect.fail(new DomainError({ code: "challenge_not_found" }));
    const sql = yield* SqlClient.SqlClient;
    const initial = (yield* rows(
      Record,
      sql`SELECT * FROM otp_router.challenges WHERE id = ${id}`,
    ))[0];
    if (initial === undefined)
      return yield* Effect.fail(new DomainError({ code: "challenge_not_found" }));
    const delivery = yield* findOperation(initial.operation_id, lock);
    const current = lock
      ? yield* single(Record, sql`SELECT * FROM otp_router.challenges WHERE id = ${id} FOR UPDATE`)
      : initial;
    return { ...current, delivery };
  });
export const findSecrets = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* single(
      Secrets,
      sql`SELECT * FROM otp_router.challenge_secrets WHERE challenge_id = ${id}`,
    );
  });
export const eraseSecrets = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM otp_router.challenge_secrets WHERE challenge_id = ${id}`;
    yield* sql`UPDATE otp_router.idempotency_records SET code_fingerprint = NULL WHERE challenge_id = ${id} AND code_fingerprint IS NOT NULL`;
  });
export const terminate = (
  challenge: Challenge,
  state: "verified" | "locked" | "expired" | "cancelled",
  time: Date,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE otp_router.challenges SET verification_state = ${state}, terminal_at = ${time} WHERE id = ${challenge.id} AND verification_state = 'active'`;
    yield* closeOperation(challenge.delivery, state === "expired" ? "expired" : "closed", time);
    yield* eraseSecrets(challenge.id);
    return yield* findChallenge(challenge.id);
  });
export const expire = (challenge: Challenge, time: Date) =>
  challenge.verification_state === "active" && time >= challenge.delivery.expires_at
    ? terminate(challenge, "expired", time)
    : Effect.succeed(challenge);
export const requireActive = (challenge: Challenge) =>
  challenge.verification_state === "active"
    ? Effect.void
    : Effect.fail(
        new DomainError({
          code:
            challenge.verification_state === "verified"
              ? "challenge_state_conflict"
              : "challenge_unavailable",
        }),
      );
