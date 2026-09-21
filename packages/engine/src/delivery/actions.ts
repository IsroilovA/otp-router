import { admissionLimit, quotaRetryAt, countQuotas } from "./quotas.js";
import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { DomainError } from "../errors.js";
import type { DeliveryInput } from "./input.js";
import type { Operation, Attempt } from "./records.js";
import { findOperation, findAttempt, requireActive, invalidRecipient } from "./store.js";
import {
  availableProviders,
  resolveChoice,
  nextProvider,
  userSendBlock,
  withAdmissionCooldown,
  type ProviderAvailability,
} from "./eligibility.js";
import { schedule } from "./schedule.js";
const selectTarget = (
  operation: Operation,
  current: Attempt,
  input: DeliveryInput,
  available: readonly ProviderAvailability[],
) => {
  switch (input.action) {
    case "select":
      return resolveChoice(operation.snapshot, input.choice, available);
    case "resend": {
      const target = available.find(
        ({ provider }) => provider.providerInstanceId === current.provider_instance_id,
      );
      return target === undefined
        ? Effect.fail(new DomainError({ code: "delivery_unavailable" }))
        : Effect.succeed(target);
    }
    case "next": {
      const target = nextProvider(available, current.route_position);
      return target === undefined
        ? Effect.fail(new DomainError({ code: "delivery_unavailable" }))
        : Effect.succeed(target);
    }
  }
};
export const requestSend = (
  config: RuntimeConfiguration,
  operation: Operation,
  input: DeliveryInput,
  time: Date,
) =>
  Effect.gen(function* () {
    yield* requireActive(operation);
    if (operation.current_attempt_id === null || (yield* invalidRecipient(operation.id)))
      return yield* Effect.fail(new DomainError({ code: "delivery_unavailable" }));
    const current = yield* findAttempt(operation.current_attempt_id);
    const target = yield* selectTarget(
      operation,
      current,
      input,
      yield* availableProviders(config, operation, time),
    );
    const admission = yield* quotaRetryAt([admissionLimit(operation.recipient_token)], time);
    const blocked = userSendBlock(
      withAdmissionCooldown(operation, admission),
      time,
      target.retryAt,
    );
    if (blocked !== undefined) return yield* Effect.fail(new DomainError(blocked));
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE otp_router.delivery_attempts SET state = 'suppressed' WHERE operation_id = ${operation.id} AND state = 'pending'`;
    yield* sql`UPDATE otp_router.delivery_operations SET routing_revision = routing_revision + 1, automatic_stopped = false, next_user_send_at = ${new Date(time.getTime() + operation.snapshot.resendCooldownSeconds * 1000)} WHERE id = ${operation.id}`;
    const attemptId = yield* schedule(
      yield* findOperation(operation.id),
      target.position,
      input.action,
      time,
    );
    yield* countQuotas([admissionLimit(operation.recipient_token)], attemptId, time);
    return attemptId;
  });
