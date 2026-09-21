import { domainTransaction } from "../delivery/transaction.js";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import { type ChallengeMutation, type OperationResult } from "./contracts.js";
import { DomainError } from "../errors.js";
import { lockOperation, operation, replay, saveResult } from "./idempotency.js";
import { expire, findChallenge, terminate } from "./store.js";
import { snapshot } from "./publication.js";
export const cancelChallenge = (
  config: RuntimeConfiguration,
  request: ChallengeMutation<Record<string, never>>,
) =>
  domainTransaction(
    config,
    Effect.gen(function* () {
      const op = operation(config.settings.crypto, request, "cancel");
      yield* lockOperation(op);
      const previous = yield* replay(config.settings.crypto, op);
      if (previous !== undefined) return previous;
      const locked = yield* findChallenge(request.challengeId, true);
      const time = yield* databaseTime;
      let challenge = yield* expire(locked, time);
      if (challenge.verification_state !== "active" && challenge.verification_state !== "cancelled")
        return yield* Effect.fail(new DomainError({ code: "challenge_state_conflict" }));
      if (challenge.verification_state === "active")
        challenge = yield* terminate(challenge, "cancelled", time);
      const response: OperationResult = {
        outcome: "completed",
        replayed: false,
        body: yield* snapshot(config, challenge, time),
      };
      return yield* saveResult(config.settings.crypto, op, {
        challengeId: challenge.id,
        response,
        active: false,
        time,
      });
    }),
  );
