import { domainTransaction } from "./transaction.js";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import { DomainError, type ChallengeMutation, type OperationResult } from "./contracts.js";
import { lockOperation, operation, replay, saveResult } from "./idempotency.js";
import { expire, findChallenge, terminate } from "./store.js";
import { snapshot } from "./snapshot.js";
export const cancelChallenge = (
  config: RuntimeConfiguration,
  request: ChallengeMutation<Record<string, never>>,
) =>
  domainTransaction(
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
        status: 200,
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
export const challengeStatus = (config: RuntimeConfiguration, id: string) =>
  domainTransaction(
    Effect.gen(function* () {
      const locked = yield* findChallenge(id, true);
      const time = yield* databaseTime;
      const challenge = yield* expire(locked, time);
      return {
        status: 200,
        replayed: false,
        body: yield* snapshot(config, challenge, time),
      } satisfies OperationResult;
    }),
  );
