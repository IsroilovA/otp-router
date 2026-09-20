import { domainTransaction } from "./transaction.js";
import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import {
  DomainError,
  type ChallengeMutation,
  type OperationResult,
  type VerifyInput,
} from "./contracts.js";
import { digest, equalDigest, verifierInput } from "./crypto.js";
import { lockOperation, operation, replay, saveResult } from "./idempotency.js";
import { checkQuotas, countQuotas, lockQuotas, recipientLimit } from "./quotas.js";
import {
  eraseSecrets,
  expire,
  findChallenge,
  findSecrets,
  requireActive,
  terminate,
} from "./store.js";
import type { Challenge } from "./records.js";

const checkBinding = (challenge: Challenge, input: VerifyInput) =>
  challenge.purpose === input.purpose && challenge.context_id === input.contextId
    ? Effect.void
    : Effect.fail(new DomainError({ code: "challenge_not_found" }));
export const verifyChallenge = (
  config: RuntimeConfiguration,
  request: ChallengeMutation<VerifyInput>,
) =>
  domainTransaction(
    Effect.gen(function* () {
      const op = {
        ...operation(
          config.settings.crypto,
          {
            ...request,
            input: { purpose: request.input.purpose, contextId: request.input.contextId },
          },
          "verify",
        ),
        code: request.input.code,
      };
      yield* lockOperation(op);
      const initial = yield* findChallenge(request.challengeId).pipe(
        Effect.catchTag("DomainError", () => Effect.succeed(undefined)),
      );
      if (initial !== undefined) yield* checkBinding(initial, request.input);
      const previous = yield* replay(config.settings.crypto, op);
      if (previous !== undefined) return previous;
      if (initial === undefined)
        return yield* Effect.fail(new DomainError({ code: "challenge_not_found" }));
      const limits = [
        recipientLimit(initial.recipient_token, "guess", config.settings.recipientGuessLimit15m),
      ];
      yield* lockQuotas(limits);
      const locked = yield* findChallenge(request.challengeId, true);
      const time = yield* databaseTime;
      const challenge = yield* expire(locked, time);
      yield* checkBinding(challenge, request.input);
      yield* requireActive(challenge);
      if (request.input.code.length !== challenge.snapshot.codeLength)
        return yield* Effect.fail(new DomainError({ code: "invalid_request" }));
      yield* checkQuotas(limits, time);
      const secret = yield* findSecrets(challenge.id);
      const candidate = digest(
        config.settings.crypto.verification,
        verifierInput(
          config.settings.crypto,
          { id: challenge.id, purpose: challenge.purpose, contextId: challenge.context_id },
          request.input.code,
        ),
        secret.verifier.keyId,
      );
      const sql = yield* PgClient.PgClient;
      if (equalDigest(candidate.value, secret.verifier.value)) {
        const verificationId = randomUUID();
        yield* sql`UPDATE otp_router.challenges SET verification_state = 'verified', verification_id = ${verificationId}, verified_at = ${time}, terminal_at = ${time}, routing_revision = routing_revision + 1, automatic_stopped = true WHERE id = ${challenge.id} AND verification_state = 'active'`;
        yield* eraseSecrets(challenge.id);
        const response: OperationResult = {
          status: 200,
          replayed: false,
          body: {
            verificationId,
            challengeId: challenge.id,
            purpose: challenge.purpose,
            contextId: challenge.context_id,
            verifiedAt: time.toISOString(),
          },
        };
        return yield* saveResult(config.settings.crypto, op, {
          challengeId: challenge.id,
          response,
          active: false,
          time,
        });
      }
      yield* sql`UPDATE otp_router.challenges SET incorrect_guesses = incorrect_guesses + 1 WHERE id = ${challenge.id} AND verification_state = 'active'`;
      yield* countQuotas(limits, randomUUID(), time);
      const active = challenge.incorrect_guesses + 1 < challenge.snapshot.maxIncorrectGuesses;
      if (!active) yield* terminate(challenge, "locked", time);
      const response: OperationResult = {
        status: 422,
        replayed: false,
        body: {
          error: {
            code: "incorrect_code",
            message: "The code is incorrect.",
            requestId: request.requestId,
            verificationState: active ? "active" : "locked",
          },
        },
      };
      return yield* saveResult(config.settings.crypto, op, {
        challengeId: challenge.id,
        response,
        active,
        time,
      });
    }),
  );
