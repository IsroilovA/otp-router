import { admissionLimit, lockQuotas } from "../delivery/quotas.js";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import type { DeliveryInput } from "../delivery/input.js";
import { requestSend } from "../delivery/actions.js";
import type { ChallengeMutation, OperationResult } from "./contracts.js";
import { operation, lockOperation, replay, saveResult } from "./idempotency.js";
import { findChallenge, expire, requireActive } from "./store.js";
import { snapshot } from "./publication.js";
import { changed } from "./changes.js";
import { domainTransaction } from "./transaction.js";
export const requestDelivery = (
  config: RuntimeConfiguration,
  request: ChallengeMutation<DeliveryInput>,
) =>
  domainTransaction(
    config,
    Effect.gen(function* () {
      const op = operation(config.settings.crypto, request, "deliver");
      yield* lockOperation(op);
      const previous = yield* replay(config.settings.crypto, op);
      if (previous !== undefined) return previous;
      const initial = yield* findChallenge(request.challengeId);
      yield* lockQuotas([admissionLimit(initial.delivery.recipient_token)]);
      const locked = yield* findChallenge(request.challengeId, true);
      const time = yield* databaseTime;
      const challenge = yield* expire(locked, time);
      yield* requireActive(challenge);
      const attemptId = yield* requestSend(config, challenge.delivery, request.input, time);
      yield* changed(challenge.id);
      const response: OperationResult = {
        outcome: "delivery_queued",
        replayed: false,
        body: {
          attemptId,
          challenge: yield* snapshot(config, yield* findChallenge(challenge.id), time),
        },
      };
      return yield* saveResult(config.settings.crypto, op, {
        challengeId: challenge.id,
        response,
        active: true,
        time,
      });
    }),
  );
