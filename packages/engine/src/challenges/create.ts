import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import { digest, generateCode } from "../crypto.js";
import { DomainError } from "../errors.js";
import { normalizePhone, prepareRoute } from "../delivery/prepare.js";
import { admitOperation, attachCode } from "../delivery/lifecycle.js";
import type { PrepareInput } from "../delivery/contracts.js";
import { verifierInput } from "./crypto.js";
import type { CreateInput, Mutation, OperationResult } from "./contracts.js";
import { operation, lockOperation, replay, saveResult } from "./idempotency.js";
import { findChallenge } from "./store.js";
import { snapshot } from "./publication.js";
import { challengeTransaction as transaction } from "./transaction.js";
export const createChallenge = (config: RuntimeConfiguration, request: Mutation<CreateInput>) =>
  Effect.gen(function* () {
    const phone = yield* normalizePhone(request.input.recipient.phoneNumber);
    const input = { ...request.input, recipient: { type: "phone" as const, phoneNumber: phone } };
    const op = operation(config.settings.crypto, { ...request, input }, "create");
    const previous = yield* transaction(
      config,
      Effect.gen(function* () {
        yield* lockOperation(op);
        return yield* replay(config.settings.crypto, op);
      }),
    );
    if (previous !== undefined) return previous;
    const managed = config.settings.policies[input.policyId]?.managed;
    const verification = config.settings.crypto.verification;
    if (managed === undefined || verification === undefined)
      return yield* Effect.fail(new DomainError({ code: "policy_not_allowed" }));
    const route = yield* prepareRoute(config, { ...input, expiresAt: new Date().toISOString() });
    return yield* transaction(
      config,
      Effect.gen(function* () {
        yield* lockOperation(op);
        const existing = yield* replay(config.settings.crypto, op);
        if (existing !== undefined) return existing;
        const time = yield* databaseTime;
        const prepared: PrepareInput = {
          ...input,
          expiresAt: new Date(time.getTime() + managed.lifetimeSeconds * 1000).toISOString(),
        };
        const delivery = yield* admitOperation(config, prepared, { ...route, owner: "challenge" });
        const id = randomUUID(),
          code = generateCode(managed.codeLength);
        const sql = yield* PgClient.PgClient;
        yield* sql`INSERT INTO otp_router.challenges(id,operation_id,purpose,context_id,code_length,max_incorrect_guesses,verification_state,created_at) VALUES (${id},${delivery.id},${input.purpose},${input.contextId},${managed.codeLength},${managed.maxIncorrectGuesses},'active',${time})`;
        yield* sql`INSERT INTO otp_router.challenge_secrets(challenge_id,verifier) VALUES (${id},${sql.json(digest(verification, verifierInput(config.settings.crypto, { id, purpose: input.purpose, contextId: input.contextId }, code)))})`;
        yield* attachCode(config, delivery, code);
        const body = yield* snapshot(config, yield* findChallenge(id), time);
        const response: OperationResult = { outcome: "created", body, replayed: false };
        return yield* saveResult(config.settings.crypto, op, {
          challengeId: id,
          response,
          active: true,
          time,
        });
      }),
    );
  });
