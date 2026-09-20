import { changed } from "./changes.js";
import { SqlClient } from "effect/unstable/sql";
import { Effect, Schema } from "effect";
import { rows, single } from "../database/query.js";
import { Challenge, Delivery, Secrets } from "./records.js";
import { DomainError } from "./contracts.js";

export const findChallenge = (id: string, lock = false) =>
  Effect.gen(function* () {
    if (!Schema.is(Schema.String.check(Schema.isUUID()))(id))
      return yield* Effect.fail(new DomainError({ code: "challenge_not_found" }));
    const sql = yield* SqlClient.SqlClient;
    const values = yield* rows(
      Challenge,
      lock
        ? sql`SELECT * FROM otp_router.challenges WHERE id = ${id} FOR UPDATE`
        : sql`SELECT * FROM otp_router.challenges WHERE id = ${id}`,
    );
    const challenge = values[0];
    if (challenge === undefined)
      return yield* Effect.fail(new DomainError({ code: "challenge_not_found" }));
    return challenge;
  });
export const findDelivery = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* single(Delivery, sql`SELECT * FROM otp_router.deliveries WHERE id = ${id}`);
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
    // Provider inputs are already in memory after the gate. No later operation needs this row.
    yield* sql`DELETE FROM otp_router.challenge_secrets WHERE challenge_id = ${id}`;
    yield* sql`UPDATE otp_router.idempotency_records SET code_fingerprint = NULL WHERE challenge_id = ${id} AND code_fingerprint IS NOT NULL`;
    yield* sql`UPDATE otp_router.deliveries SET state = 'suppressed' WHERE challenge_id = ${id} AND state = 'pending'`;
  });
export const terminate = (
  challenge: Challenge,
  state: "verified" | "locked" | "expired" | "cancelled",
  time: Date,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE otp_router.challenges SET verification_state = ${state}, terminal_at = ${time}, routing_revision = routing_revision + 1, automatic_stopped = true WHERE id = ${challenge.id} AND verification_state = 'active'`;
    yield* eraseSecrets(challenge.id);
    yield* changed(challenge.id);
    return yield* findChallenge(challenge.id);
  });
export const expire = (challenge: Challenge, time: Date) =>
  challenge.verification_state === "active" && time >= challenge.expires_at
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

export const invalidRecipient = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* single(
      Schema.Struct({ stopped: Schema.Boolean }),
      sql`SELECT EXISTS (SELECT 1 FROM otp_router.deliveries WHERE challenge_id = ${id} AND failure_category = 'InvalidRecipient') AS stopped`,
    )).stopped;
  });
