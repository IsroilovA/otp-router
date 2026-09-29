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
import { admissionLimit, checkQuotas, countQuotas, lockQuotas, recipientLimit } from "./quotas.js";
import { expire, findOperation, findSecrets } from "./store.js";
import { schedule } from "./schedule.js";

export const admitOperation = (
  config: RuntimeConfiguration,
  input: PrepareInput,
  prepared: {
    readonly saved: PolicySnapshot;
    readonly projectId: string;
    readonly owner: Operation["owner"];
  },
) =>
  Effect.gen(function* () {
    const token = recipientToken(
      config.settings.crypto,
      prepared.projectId,
      input.recipient.phoneNumber,
    );
    const limits = [
      recipientLimit(token, "create", config.settings.recipientCreateLimit15m),
      admissionLimit(token),
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
        {
          snapshot: prepared.saved,
          project_id: prepared.projectId,
          recipient_token: token,
          expires_at: deadline,
        },
        time,
      ),
    );
    const id = randomUUID();
    const sql = yield* PgClient.PgClient;
    yield* sql`INSERT INTO otp_router.delivery_operations(id,project_id,owner,purpose,context_id,recipient_token,policy_id,authorization_required,max_sends,resend_cooldown_seconds,manual_selection_enabled,state,created_at,expires_at,initial_position,next_user_send_at) VALUES (${id},${prepared.projectId},${prepared.owner},${input.purpose},${input.contextId},${token},${input.policyId},${prepared.saved.authorizationRequired},${prepared.saved.maxSends},${prepared.saved.resendCooldownSeconds},${prepared.saved.manualSelectionEnabled},'prepared',${time},${deadline},${target.position},${time})`;
    for (const [position, provider] of prepared.saved.providers.entries()) {
      yield* sql`INSERT INTO otp_router.operation_route_steps(operation_id,position,provider_instance_id,label,plugin_id,contract_version,channel,resolved_locale,template,send_timeout_ms,min_delivery_window_ms,compatibility_revision,manual_selection_allowed)
        VALUES (${id},${position},${provider.providerInstanceId},${provider.label},${provider.pluginId},${provider.contractVersion},${provider.channel},${provider.resolvedLocale},${JSON.stringify(provider.template)}::jsonb,${provider.sendTimeoutMs},${provider.minDeliveryWindowMs},${provider.compatibilityRevision},${provider.manualSelectionAllowed})`;
    }
    yield* sql`INSERT INTO otp_router.delivery_secrets(operation_id,phone) VALUES (${id},${sql.json(encrypt(config.settings.crypto, { projectId: prepared.projectId, operationId: id }, "phone", input.recipient.phoneNumber))})`;
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
    const secret = yield* findSecrets(operation.id);
    const fingerprint = digest(
      config.settings.crypto.fingerprint,
      [
        1,
        "delivery-code",
        config.settings.crypto.deploymentId,
        operation.project_id,
        operation.id,
        code,
      ],
      secret.code_fingerprint?.keyId,
    );
    if (secret.code_fingerprint !== null) {
      if (!equalDigest(fingerprint.value, secret.code_fingerprint.value))
        return yield* Effect.fail(new DomainError({ code: "operation_state_conflict" }));
      return operation;
    }
    // Provider changes affect new attachments, not comparison with a saved code.
    for (const saved of operation.snapshot.providers) {
      const provider = config.providers.get(saved.providerInstanceId);
      if (
        provider === undefined ||
        code.length < provider.constraints.minCodeLength ||
        code.length > provider.constraints.maxCodeLength
      )
        return yield* Effect.fail(new DomainError({ code: "invalid_request" }));
    }
    const sql = yield* PgClient.PgClient;
    yield* sql`UPDATE otp_router.delivery_secrets SET code = ${sql.json(encrypt(config.settings.crypto, { projectId: operation.project_id, operationId: operation.id }, "code", code))}, code_fingerprint = ${sql.json(fingerprint)} WHERE operation_id = ${operation.id} AND code IS NULL`;
    yield* sql`UPDATE otp_router.delivery_operations SET state = 'active', next_user_send_at = ${new Date(time.getTime() + operation.snapshot.resendCooldownSeconds * 1000)} WHERE id = ${operation.id} AND state = 'prepared'`;
    const active = yield* findOperation(operation.id);
    yield* schedule(active, operation.initial_position, "initial", time);
    return yield* findOperation(operation.id);
  });
