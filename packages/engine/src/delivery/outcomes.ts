import { changed } from "./changes.js";
import { deliveryTransaction as transaction } from "./transaction.js";
import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";
import type { ProviderSendError } from "../providers/contract.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import { expire, findOperation, findAttempt } from "./store.js";
import type { Operation, Attempt } from "./records.js";
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
const shouldAdvance = (operation: Operation, delivery: Attempt, outcome: Outcome) =>
  outcome.state === "failed" &&
  outcome.stop !== true &&
  delivery.state !== "failed" &&
  delivery.state !== "delivered" &&
  operation.state === "active" &&
  !operation.automatic_stopped &&
  operation.current_attempt_id === delivery.id &&
  operation.routing_revision === delivery.routing_revision;
const nextState = (delivery: Attempt, outcome: Outcome): Outcome["state"] | Attempt["state"] => {
  if (delivery.state === "delivered") return "delivered";
  if (delivery.state === "failed" && outcome.state !== "delivered") return "failed";
  if (delivery.state === "suppressed") return "suppressed";
  if (outcome.state === "uncertain" && delivery.state === "accepted") return "accepted";
  return outcome.state;
};
export const mergeLockedOutcome = (
  config: RuntimeConfiguration,
  operation: Operation,
  delivery: Attempt,
  outcome: Outcome,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const time = yield* databaseTime;
    const state = nextState(delivery, outcome);
    if (!(yield* persistOutcome(delivery, outcome, { state, time }))) return;
    if (
      operation.state === "active" &&
      (state !== delivery.state ||
        delivery.acceptance !== outcome.acceptance ||
        outcome.stop === true ||
        outcome.retryAt !== undefined)
    )
      yield* changed(operation.id);
    if (outcome.stop === true) {
      yield* sql`UPDATE otp_router.delivery_operations SET automatic_stopped = true WHERE id = ${operation.id}`;
      yield* sql`UPDATE otp_router.delivery_attempts SET state = 'suppressed' WHERE operation_id = ${operation.id} AND state = 'pending'`;
    }
    yield* stopFallbackOnEvidence(operation, delivery, state);
    if (shouldAdvance(operation, delivery, outcome)) {
      const next = nextProvider(
        yield* availableProviders(config, operation, time),
        delivery.route_position,
      );
      if (
        next !== undefined &&
        next.retryAt === undefined &&
        operation.send_count < operation.snapshot.maxSends
      )
        yield* schedule(operation, next.position, "fallback", time);
    }
  });
const stopFallbackOnEvidence = (operation: Operation, delivery: Attempt, state: Attempt["state"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if ((state === "delivered" || state === "accepted") && delivery.state !== state) {
      if (state === "delivered")
        yield* sql`UPDATE otp_router.delivery_operations SET automatic_stopped = true WHERE id = ${operation.id}`;
      yield* sql`UPDATE otp_router.delivery_attempts SET state = 'suppressed' WHERE operation_id = ${operation.id} AND state = 'pending' AND reason = 'fallback'`;
    }
  });
export const recordOutcome = (config: RuntimeConfiguration, id: string, outcome: Outcome) =>
  transaction(
    config,
    Effect.gen(function* () {
      const initial = yield* findAttempt(id);
      const locked = yield* findOperation(initial.operation_id, true);
      const operation = yield* expire(locked, yield* databaseTime);
      const delivery = yield* findAttempt(id);
      yield* mergeLockedOutcome(config, operation, delivery, outcome);
    }),
  );

const persistOutcome = (
  delivery: Attempt,
  outcome: Outcome,
  decision: { readonly state: Attempt["state"]; readonly time: Date },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { state, time } = decision;
    if (outcome.retryAt !== undefined)
      yield* sql`INSERT INTO otp_router.provider_restrictions(provider_instance_id,retry_at) VALUES (${delivery.provider_instance_id},${outcome.retryAt}) ON CONFLICT (provider_instance_id) DO UPDATE SET retry_at = GREATEST(provider_restrictions.retry_at,EXCLUDED.retry_at)`;
    if (state !== outcome.state) {
      yield* sql`UPDATE otp_router.delivery_attempts SET provider_request_id = COALESCE(${outcome.providerRequestId ?? null},provider_request_id) WHERE id = ${delivery.id}`;
      return false;
    }
    yield* sql`UPDATE otp_router.delivery_attempts SET state = ${state}, acceptance = ${state === "delivered" ? "accepted" : outcome.acceptance}, failure_category = ${outcome.failureCategory ?? null}, diagnostic_code = ${outcome.diagnosticCode ?? null}, completed_at = ${time}, provider_request_id = COALESCE(${outcome.providerRequestId ?? null},provider_request_id), retry_at = COALESCE(${outcome.retryAt ?? null},retry_at) WHERE id = ${delivery.id}`;
    return true;
  });
