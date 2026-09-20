import { domainTransaction } from "../challenges/transaction.js";
import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import {
  DomainError,
  type ChallengeMutation,
  type DeliveryInput,
  type OperationResult,
} from "../challenges/contracts.js";
import { lockOperation, operation, replay, saveResult } from "../challenges/idempotency.js";
import {
  expire,
  findChallenge,
  findDelivery,
  requireActive,
  invalidRecipient,
} from "../challenges/store.js";
import { snapshot } from "../challenges/snapshot.js";
import type { Challenge, Delivery } from "../challenges/records.js";
import { availableProviders, resolveChoice, type ProviderAvailability } from "./eligibility.js";
import { schedule } from "./schedule.js";
const selectTarget = (
  challenge: Challenge,
  current: Delivery,
  input: DeliveryInput,
  available: readonly ProviderAvailability[],
) => {
  switch (input.action) {
    case "select":
      return resolveChoice(challenge.snapshot, input.choice, available);
    case "resend": {
      const target = available.find(
        ({ provider }) => provider.providerInstanceId === current.provider_instance_id,
      );
      return target === undefined
        ? Effect.fail(new DomainError({ code: "delivery_unavailable" }))
        : Effect.succeed(target);
    }
    case "next": {
      const target = available.find(
        ({ provider }) => challenge.snapshot.providers.indexOf(provider) > current.route_position,
      );
      return target === undefined
        ? Effect.fail(new DomainError({ code: "delivery_unavailable" }))
        : Effect.succeed(target);
    }
  }
};
export const requestDelivery = (
  config: RuntimeConfiguration,
  request: ChallengeMutation<DeliveryInput>,
) =>
  domainTransaction(
    Effect.gen(function* () {
      const op = operation(config.settings.crypto, request, "deliver");
      yield* lockOperation(op);
      const previous = yield* replay(config.settings.crypto, op);
      if (previous !== undefined) return previous;
      const locked = yield* findChallenge(request.challengeId, true);
      const time = yield* databaseTime;
      const challenge = yield* expire(locked, time);
      yield* requireActive(challenge);
      const current = yield* findDelivery(challenge.current_delivery_id);
      if (yield* invalidRecipient(challenge.id))
        return yield* Effect.fail(new DomainError({ code: "delivery_unavailable" }));
      const target = yield* selectTarget(
        challenge,
        current,
        request.input,
        yield* availableProviders(config, challenge, time),
      );
      if (time < challenge.next_user_send_at)
        return yield* Effect.fail(
          new DomainError({
            code: "cooldown_active",
            retryAt: challenge.next_user_send_at.toISOString(),
          }),
        );
      if (challenge.send_count >= challenge.snapshot.maxSends)
        return yield* Effect.fail(new DomainError({ code: "rate_limited" }));
      if (target.retryAt !== undefined)
        return yield* Effect.fail(
          new DomainError({ code: "rate_limited", retryAt: target.retryAt }),
        );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE otp_router.deliveries SET state = 'suppressed' WHERE challenge_id = ${challenge.id} AND state = 'pending'`;
      yield* sql`UPDATE otp_router.challenges SET routing_revision = routing_revision + 1, automatic_stopped = false, next_user_send_at = ${new Date(time.getTime() + challenge.snapshot.resendCooldownSeconds * 1000)} WHERE id = ${challenge.id}`;
      const updated = yield* findChallenge(challenge.id);
      const deliveryId = yield* schedule(
        updated,
        challenge.snapshot.providers.indexOf(target.provider),
        request.input.action,
        time,
      );
      const body = {
        deliveryId,
        challenge: yield* snapshot(config, yield* findChallenge(challenge.id), time),
      };
      const response: OperationResult = { status: 202, replayed: false, body };
      return yield* saveResult(config.settings.crypto, op, {
        challengeId: challenge.id,
        response,
        active: true,
        time,
      });
    }),
  );
