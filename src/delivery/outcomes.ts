import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";
import type { ProviderSendError } from "../providers/contract.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime, transaction } from "../database/transaction.js";
import { expire, findChallenge, findDelivery } from "../challenges/store.js";
import type { Challenge, Delivery } from "../challenges/records.js";
import { availableProviders, nextProvider } from "./eligibility.js";
import { schedule } from "./schedule.js";

export interface Outcome {
  readonly state: "accepted" | "delivered" | "failed" | "uncertain";
  readonly acceptance: "accepted" | "not_accepted" | "unknown";
  readonly failureCategory?: ProviderSendError["_tag"];
  readonly diagnosticCode?: string;
  readonly providerRequestId?: string;
  readonly retryAt?: Date;
  readonly stop?: boolean;
}
const shouldAdvance = (challenge: Challenge, delivery: Delivery, outcome: Outcome) =>
  outcome.state === "failed" &&
  outcome.stop !== true &&
  delivery.state !== "failed" &&
  delivery.state !== "delivered" &&
  challenge.verification_state === "active" &&
  !challenge.automatic_stopped &&
  challenge.current_delivery_id === delivery.id &&
  challenge.routing_revision === delivery.routing_revision;
const nextState = (delivery: Delivery, outcome: Outcome): Outcome["state"] | Delivery["state"] => {
  if (delivery.state === "delivered") return "delivered";
  if (delivery.state === "failed" && outcome.state !== "delivered") return "failed";
  if (delivery.state === "suppressed") return "suppressed";
  if (outcome.state === "uncertain" && delivery.state === "accepted") return "accepted";
  return outcome.state;
};
export const mergeLockedOutcome = (
  config: RuntimeConfiguration,
  challenge: Challenge,
  delivery: Delivery,
  outcome: Outcome,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const time = yield* databaseTime;
    const state = nextState(delivery, outcome);
    if (!(yield* persistOutcome(delivery, outcome, { state, time }))) return;
    if (outcome.stop === true) {
      yield* sql`UPDATE otp_router.challenges SET automatic_stopped = true WHERE id = ${challenge.id}`;
      yield* sql`UPDATE otp_router.deliveries SET state = 'suppressed' WHERE challenge_id = ${challenge.id} AND state = 'pending'`;
    }
    if (state === "delivered" && delivery.state !== "delivered") {
      yield* sql`UPDATE otp_router.challenges SET automatic_stopped = true WHERE id = ${challenge.id}`;
      yield* sql`UPDATE otp_router.deliveries SET state = 'suppressed' WHERE challenge_id = ${challenge.id} AND state = 'pending' AND reason = 'fallback'`;
    }
    if (shouldAdvance(challenge, delivery, outcome)) {
      const next = nextProvider(
        yield* availableProviders(config, challenge, time),
        delivery.route_position,
      );
      if (
        next !== undefined &&
        next.retryAt === undefined &&
        challenge.send_count < challenge.snapshot.maxSends
      )
        yield* schedule(challenge, next.position, "fallback", time);
    }
  });
export const recordOutcome = (config: RuntimeConfiguration, id: string, outcome: Outcome) =>
  transaction(
    Effect.gen(function* () {
      const initial = yield* findDelivery(id);
      const locked = yield* findChallenge(initial.challenge_id, true);
      const challenge = yield* expire(locked, yield* databaseTime);
      const delivery = yield* findDelivery(id);
      yield* mergeLockedOutcome(config, challenge, delivery, outcome);
    }),
  );

const persistOutcome = (
  delivery: Delivery,
  outcome: Outcome,
  decision: { readonly state: Delivery["state"]; readonly time: Date },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { state, time } = decision;
    if (outcome.retryAt !== undefined)
      yield* sql`INSERT INTO otp_router.provider_restrictions(provider_instance_id,retry_at) VALUES (${delivery.provider_instance_id},${outcome.retryAt}) ON CONFLICT (provider_instance_id) DO UPDATE SET retry_at = GREATEST(provider_restrictions.retry_at,EXCLUDED.retry_at)`;
    if (state !== outcome.state) {
      yield* sql`UPDATE otp_router.deliveries SET provider_request_id = COALESCE(${outcome.providerRequestId ?? null},provider_request_id) WHERE id = ${delivery.id}`;
      return false;
    }
    yield* sql`UPDATE otp_router.deliveries SET state = ${state}, acceptance = ${state === "delivered" ? "accepted" : outcome.acceptance}, failure_category = ${outcome.failureCategory ?? null}, diagnostic_code = ${outcome.diagnosticCode ?? null}, completed_at = ${time}, provider_request_id = COALESCE(${outcome.providerRequestId ?? null},provider_request_id), retry_at = COALESCE(${outcome.retryAt ?? null},retry_at) WHERE id = ${delivery.id}`;
    return true;
  });
