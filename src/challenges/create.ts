import { duration } from "../diagnostics/metrics.js";
import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { SelectorResult, type RuntimeConfiguration } from "../config/config.js";
import { databaseTime, transaction } from "../database/transaction.js";
import { LocaleSchema, NormalizedPhoneSchema } from "../providers/contract.js";
import { resolveChoice, availableProviders } from "../delivery/eligibility.js";
import { schedule } from "../delivery/schedule.js";
import { DomainError, type CreateInput, type Mutation, type OperationResult } from "./contracts.js";
import { digest, encrypt, generateCode, recipientToken, verifierInput } from "./crypto.js";
import { lockOperation, operation, replay, saveResult } from "./idempotency.js";
import { checkQuotas, countQuotas, lockQuotas, recipientLimit } from "./quotas.js";
import type { PolicySnapshot } from "./records.js";
import { findChallenge } from "./store.js";
import { snapshot } from "./snapshot.js";

export const normalizePhone = (phone: string) =>
  Effect.gen(function* () {
    if (!phone.startsWith("+"))
      return yield* Effect.fail(new DomainError({ code: "invalid_recipient" }));
    const parsed = parsePhoneNumberFromString(phone);
    if (parsed === undefined || !parsed.isValid() || parsed.ext !== undefined)
      return yield* Effect.fail(new DomainError({ code: "invalid_recipient" }));
    return yield* Schema.decodeUnknown(NormalizedPhoneSchema)(parsed.number).pipe(
      Effect.mapError(() => new DomainError({ code: "invalid_recipient" })),
    );
  });
const prepare = (config: RuntimeConfiguration, input: CreateInput) =>
  Effect.gen(function* () {
    const policy = config.settings.policies[input.policyId];
    if (
      policy === undefined ||
      config.settings.purposes[input.purpose]?.includes(input.policyId) !== true
    )
      return yield* Effect.fail(new DomainError({ code: "policy_not_allowed" }));
    const recipient = yield* Schema.decodeUnknown(NormalizedPhoneSchema)(
      input.recipient.phoneNumber,
    );
    const locale = input.locale ?? config.settings.defaultLocale;
    const route = yield* selectRoute(config, {
      input,
      recipient,
      locale,
      permitted: policy.providerInstanceIds,
    });
    const locales = yield* Schema.decodeUnknown(Schema.Array(LocaleSchema))([
      ...new Set([locale, ...config.settings.fallbackLocales]),
    ]);
    const providers = yield* Effect.forEach(route.providerInstanceIds, (id) =>
      Effect.gen(function* () {
        const provider = config.providers.get(id);
        if (provider === undefined)
          return yield* Effect.fail(new DomainError({ code: "delivery_unavailable" }));
        const resolved = yield* provider
          .resolveTemplate(locales)
          .pipe(Effect.mapError(() => new DomainError({ code: "delivery_unavailable" })));
        return {
          providerInstanceId: id,
          pluginId: provider.pluginId,
          contractVersion: provider.contractVersion,
          channel: provider.channel,
          resolvedLocale: resolved.locale,
          template: resolved.template,
          sendTimeoutMs: provider.sendTimeoutMs,
          minDeliveryWindowMs: provider.constraints.minDeliveryWindowMs,
          settingsFingerprint: provider.settingsFingerprint,
        };
      }),
    );
    const saved: PolicySnapshot = {
      version: 1,
      policyId: input.policyId,
      codeLength: policy.codeLength,
      lifetimeSeconds: policy.lifetimeSeconds,
      maxIncorrectGuesses: policy.maxIncorrectGuesses,
      maxSends: policy.maxSends,
      resendCooldownSeconds: policy.resendCooldownSeconds,
      manualSelectionEnabled: policy.manualSelectionEnabled,
      manualProviderIds: policy.manualProviderIds ?? policy.providerInstanceIds,
      requestedLocale: locale,
      providers,
    };
    return { saved };
  });
export const createChallenge = (config: RuntimeConfiguration, request: Mutation<CreateInput>) =>
  Effect.gen(function* () {
    const phone = yield* normalizePhone(request.input.recipient.phoneNumber);
    const input = { ...request.input, recipient: { type: "phone" as const, phoneNumber: phone } };
    const op = operation(config.settings.crypto, { ...request, input }, "create");
    const previous = yield* transaction(
      Effect.gen(function* () {
        yield* lockOperation(op);
        return yield* replay(config.settings.crypto, op);
      }),
    );
    if (previous !== undefined) return previous;
    const prepared = yield* prepare(config, input);
    return yield* transaction(
      Effect.gen(function* () {
        yield* lockOperation(op);
        const existing = yield* replay(config.settings.crypto, op);
        if (existing !== undefined) return existing;
        const token = recipientToken(config.settings.crypto, phone);
        const limits = [recipientLimit(token, "create", config.settings.recipientCreateLimit15m)];
        yield* lockQuotas(limits);
        const time = yield* databaseTime;
        const position = yield* initialPosition(config, input, prepared.saved, { token, time });
        yield* checkQuotas(limits, time);
        const id = randomUUID(),
          deliveryId = randomUUID(),
          code = generateCode(prepared.saved.codeLength);
        const sql = yield* PgClient.PgClient;
        yield* sql`INSERT INTO otp_router.challenges(id,purpose,context_id,recipient_token,policy_id,snapshot,verification_state,created_at,expires_at,current_delivery_id,next_user_send_at) VALUES (${id},${input.purpose},${input.contextId},${token},${input.policyId},${sql.json(prepared.saved)},'active',${time},${new Date(time.getTime() + prepared.saved.lifetimeSeconds * 1000)},${deliveryId},${new Date(time.getTime() + prepared.saved.resendCooldownSeconds * 1000)})`;
        yield* sql`INSERT INTO otp_router.challenge_secrets(challenge_id,phone,code,verifier) VALUES (${id},${sql.json(encrypt(config.settings.crypto, id, "phone", phone))},${sql.json(encrypt(config.settings.crypto, id, "code", code))},${sql.json(digest(config.settings.crypto.verification, verifierInput(config.settings.crypto, { id, purpose: input.purpose, contextId: input.contextId }, code)))})`;
        yield* countQuotas(limits, id, time);
        const challenge = yield* findChallenge(id);
        yield* schedule(challenge, position, "initial", time);
        const body = yield* snapshot(config, challenge, time);
        const response: OperationResult = { status: 201, body, replayed: false };
        return yield* saveResult(config.settings.crypto, op, {
          challengeId: id,
          response,
          active: true,
          time,
        });
      }),
    );
  });

const selectRoute = (
  config: RuntimeConfiguration,
  options: {
    readonly input: CreateInput;
    readonly recipient: typeof NormalizedPhoneSchema.Type;
    readonly locale: string;
    readonly permitted: readonly string[];
  },
) =>
  Effect.gen(function* () {
    const { input, recipient, locale, permitted } = options;
    const selector = config.selectors[input.policyId];
    const started = performance.now();
    const selected =
      selector === undefined
        ? { _tag: "Route" as const, providerInstanceIds: permitted }
        : yield* selector({
            recipient,
            purpose: input.purpose,
            locale,
            routingContext: input.routingContext ?? {},
          }).pipe(
            Effect.timeoutFail({
              duration: config.settings.selectorTimeoutMs,
              onTimeout: () => new DomainError({ code: "temporarily_unavailable" }),
            }),
            Effect.mapError(() => new DomainError({ code: "temporarily_unavailable" })),
            Effect.ensuring(
              Effect.suspend(() => duration("selector", performance.now() - started)),
            ),
          );
    const route = yield* Schema.decodeUnknown(SelectorResult)(selected, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new DomainError({ code: "temporarily_unavailable" })));
    if (route._tag === "Reject")
      return yield* Effect.fail(new DomainError({ code: "delivery_unavailable" }));
    if (
      new Set(route.providerInstanceIds).size !== route.providerInstanceIds.length ||
      route.providerInstanceIds.some((id) => !permitted.includes(id))
    )
      return yield* Effect.fail(new DomainError({ code: "temporarily_unavailable" }));
    return route;
  });

const initialPosition = (
  config: RuntimeConfiguration,
  input: CreateInput,
  saved: PolicySnapshot,
  context: { readonly token: string; readonly time: Date },
) =>
  Effect.gen(function* () {
    const { token, time } = context;
    const available = yield* availableProviders(
      config,
      {
        snapshot: saved,
        recipient_token: token,
        expires_at: new Date(time.getTime() + saved.lifetimeSeconds * 1000),
      },
      time,
    );
    const selected = yield* resolveChoice(saved, input.deliveryChoice, available);
    if (selected.retryAt !== undefined)
      return yield* Effect.fail(
        new DomainError({ code: "rate_limited", retryAt: selected.retryAt }),
      );
    return saved.providers.indexOf(selected.provider);
  });
