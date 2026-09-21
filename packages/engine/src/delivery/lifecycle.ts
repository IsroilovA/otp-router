import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import { digest, equalDigest, encrypt, recipientToken } from "../crypto.js";
import { DomainError } from "../errors.js";
import { enqueueExpiry } from "../queue/jobs.js";
import type { PrepareInput } from "./contracts.js";
import type { Operation, PolicySnapshot } from "./records.js";
import { changed } from "./changes.js";
import { availableProviders, resolveChoice } from "./eligibility.js";
import { checkQuotas, countQuotas, lockQuotas, recipientLimit } from "./quotas.js";
import { expire, findOperation, findSecrets } from "./store.js";
import { schedule } from "./schedule.js";

export const admitOperation = (
  config: RuntimeConfiguration,
  input: PrepareInput,
  prepared: { readonly saved: PolicySnapshot; readonly owner: Operation["owner"] },
) =>
  Effect.gen(function* () {
    const token = recipientToken(config.settings.crypto, input.recipient.phoneNumber);
    const limits = [
      recipientLimit(token, "create", config.settings.recipientCreateLimit15m),
      { identity: `recipient:${token}`, kind: "admission" as const, maximum: 1, windowMs: 30000 },
    ];
    yield* lockQuotas(limits);
    const time = yield* databaseTime;
    const deadline = new Date(input.expiresAt);
    const policy = config.settings.policies[input.policyId];
    if (
      policy === undefined ||
      deadline <= time ||
      deadline.getTime() - time.getTime() > policy.maxLifetimeSeconds * 1000
    )
      return yield* Effect.fail(new DomainError({ code: "invalid_request" }));
    yield* checkQuotas(limits, time);
    const target = yield* resolveChoice(
      prepared.saved,
      input.deliveryChoice,
      yield* availableProviders(
        config,
        { snapshot: prepared.saved, recipient_token: token, expires_at: deadline },
        time,
      ),
    );
    const id = randomUUID();
    const sql = yield* PgClient.PgClient;
    yield* sql`INSERT INTO otp_router.delivery_operations(id,owner,purpose,context_id,recipient_token,policy_id,snapshot,state,created_at,expires_at,initial_position,next_user_send_at) VALUES (${id},${prepared.owner},${input.purpose},${input.contextId},${token},${input.policyId},${sql.json(prepared.saved)},'prepared',${time},${deadline},${target.position},${time})`;
    yield* sql`INSERT INTO otp_router.delivery_secrets(operation_id,phone) VALUES (${id},${sql.json(encrypt(config.settings.crypto, id, "phone", input.recipient.phoneNumber))})`;
    yield* countQuotas(limits, id, time);
    yield* enqueueExpiry(id, deadline);
    yield* changed(id);
    return yield* findOperation(id);
  });
export const attachCode = (config: RuntimeConfiguration, original: Operation, code: string) =>
  Effect.gen(function* () {
    const time = yield* databaseTime;
    const operation = yield* expire(original, time);
    if (operation.state === "closed" || operation.state === "expired")
      return yield* Effect.fail(new DomainError({ code: "operation_unavailable" }));
    for (const saved of operation.snapshot.providers) {
      const provider = config.providers.get(saved.providerInstanceId);
      if (
        provider === undefined ||
        code.length < provider.constraints.minCodeLength ||
        code.length > provider.constraints.maxCodeLength ||
        !/^[0-9]{6,8}$/.test(code)
      )
        return yield* Effect.fail(new DomainError({ code: "invalid_request" }));
    }
    const secret = yield* findSecrets(operation.id);
    const fingerprint = digest(
      config.settings.crypto.fingerprint,
      [1, "delivery-code", config.settings.crypto.deploymentId, operation.id, code],
      secret.code_fingerprint?.keyId,
    );
    if (secret.code_fingerprint !== null) {
      if (!equalDigest(fingerprint.value, secret.code_fingerprint.value))
        return yield* Effect.fail(new DomainError({ code: "operation_state_conflict" }));
      return operation;
    }
    const sql = yield* PgClient.PgClient;
    yield* sql`UPDATE otp_router.delivery_secrets SET code = ${sql.json(encrypt(config.settings.crypto, operation.id, "code", code))}, code_fingerprint = ${sql.json(fingerprint)} WHERE operation_id = ${operation.id} AND code IS NULL`;
    yield* sql`UPDATE otp_router.delivery_operations SET state = 'active', next_user_send_at = ${new Date(time.getTime() + operation.snapshot.resendCooldownSeconds * 1000)} WHERE id = ${operation.id} AND state = 'prepared'`;
    const active = yield* findOperation(operation.id);
    yield* schedule(active, operation.initial_position, "initial", time);
    return yield* findOperation(operation.id);
  });
