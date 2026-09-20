import { domainTransaction } from "../challenges/transaction.js";
import { SqlClient } from "@effect/sql";
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
import { checkQuotas, lockQuotas, sendLimits, quotaRetryAt } from "../challenges/quotas.js";
import {
  expire,
  findChallenge,
  findDelivery,
  requireActive,
  invalidRecipient,
} from "../challenges/store.js";
import { snapshot } from "../challenges/snapshot.js";
import type { Challenge, Delivery, SavedProvider } from "../challenges/records.js";
import { eligibleProviders, resolveChoice } from "./eligibility.js";
import { schedule } from "./schedule.js";
const selectTarget = (
  challenge: Challenge,
  current: Delivery,
  input: DeliveryInput,
  eligible: readonly SavedProvider[],
) => {
  switch (input.action) {
    case "select":
      return resolveChoice(challenge.snapshot, input.choice, eligible);
    case "resend": {
      const target = eligible.find(
        (provider) => provider.providerInstanceId === current.provider_instance_id,
      );
      return target === undefined
        ? Effect.fail(new DomainError({ code: "delivery_unavailable" }))
        : Effect.succeed(target);
    }
    case "next": {
      const target = challenge.snapshot.providers
        .slice(current.route_position + 1)
        .find((provider) => eligible.includes(provider));
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
      const initial = yield* findChallenge(request.challengeId);
      // Lock every potentially chosen provider quota before locking the challenge.
      const allLimits = initial.snapshot.providers.flatMap((provider) =>
        sendLimits(config.settings, initial.recipient_token, provider.providerInstanceId),
      );
      yield* lockQuotas(allLimits);
      const locked = yield* findChallenge(request.challengeId, true);
      const time = yield* databaseTime;
      const challenge = yield* expire(locked, time);
      yield* requireActive(challenge);
      const current = yield* findDelivery(challenge.current_delivery_id);
      if (yield* invalidRecipient(challenge.id))
        return yield* Effect.fail(new DomainError({ code: "delivery_unavailable" }));
      const target = yield* targetWithQuota(config, {
        challenge,
        current,
        input: request.input,
        eligible: yield* eligibleProviders(config, challenge, time),
        time,
      });
      if (time < challenge.next_user_send_at)
        return yield* Effect.fail(
          new DomainError({
            code: "cooldown_active",
            retryAt: challenge.next_user_send_at.toISOString(),
          }),
        );
      if (challenge.send_count >= challenge.snapshot.maxSends)
        return yield* Effect.fail(new DomainError({ code: "rate_limited" }));
      yield* checkQuotas(
        sendLimits(config.settings, challenge.recipient_token, target.providerInstanceId),
        time,
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE otp_router.deliveries SET state = 'suppressed' WHERE challenge_id = ${challenge.id} AND state = 'pending'`;
      yield* sql`UPDATE otp_router.challenges SET routing_revision = routing_revision + 1, automatic_stopped = false, next_user_send_at = ${new Date(time.getTime() + challenge.snapshot.resendCooldownSeconds * 1000)} WHERE id = ${challenge.id}`;
      const updated = yield* findChallenge(challenge.id);
      const deliveryId = yield* schedule(
        updated,
        challenge.snapshot.providers.indexOf(target),
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

const targetWithQuota = (
  config: RuntimeConfiguration,
  options: {
    readonly challenge: Challenge;
    readonly current: Delivery;
    readonly input: DeliveryInput;
    readonly eligible: readonly SavedProvider[];
    readonly time: Date;
  },
) =>
  Effect.gen(function* () {
    const { challenge, current, input, eligible, time } = options;
    const first = yield* selectTarget(challenge, current, input, eligible);
    if (input.action !== "select" || input.choice.type !== "channel") return first;
    for (const candidate of eligible) {
      if (
        candidate.channel !== first.channel ||
        !challenge.snapshot.manualProviderIds.includes(candidate.providerInstanceId)
      )
        continue;
      const retry = yield* quotaRetryAt(
        sendLimits(config.settings, challenge.recipient_token, candidate.providerInstanceId),
        time,
      );
      if (retry === undefined) return candidate;
    }
    return first;
  });
