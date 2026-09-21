import { Effect, Schema } from "effect";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { duration } from "../diagnostics/metrics.js";
import { SelectorResult, type RuntimeConfiguration } from "../config/config.js";
import { LocaleSchema, NormalizedPhoneSchema } from "../providers/contract.js";
import { DomainError } from "../errors.js";
import type { PrepareInput } from "./contracts.js";
import type { PolicySnapshot } from "./records.js";
export const normalizePhone = (phone: string) =>
  Effect.gen(function* () {
    if (!phone.startsWith("+"))
      return yield* Effect.fail(new DomainError({ code: "invalid_recipient" }));
    const parsed = parsePhoneNumberFromString(phone);
    if (parsed === undefined || !parsed.isValid() || parsed.ext !== undefined)
      return yield* Effect.fail(new DomainError({ code: "invalid_recipient" }));
    return yield* Schema.decodeUnknownEffect(NormalizedPhoneSchema)(parsed.number).pipe(
      Effect.mapError(() => new DomainError({ code: "invalid_recipient" })),
    );
  });
export const prepareRoute = (config: RuntimeConfiguration, input: PrepareInput) =>
  Effect.gen(function* () {
    const policy = config.settings.policies[input.policyId];
    if (
      policy === undefined ||
      config.settings.purposes[input.purpose]?.includes(input.policyId) !== true
    )
      return yield* Effect.fail(new DomainError({ code: "policy_not_allowed" }));
    const recipient = yield* Schema.decodeUnknownEffect(NormalizedPhoneSchema)(
      input.recipient.phoneNumber,
    );
    const locale = input.locale ?? config.settings.defaultLocale;
    const route = yield* selectRoute(config, {
      input,
      recipient,
      locale,
      permitted: policy.providerInstanceIds,
    });
    const locales = yield* Schema.decodeUnknownEffect(Schema.Array(LocaleSchema))([
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
          label: config.settings.providerLabels[id] ?? provider.channel,
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
      maxSends: policy.maxSends,
      resendCooldownSeconds: policy.resendCooldownSeconds,
      manualSelectionEnabled: policy.manualSelectionEnabled,
      manualProviderIds: policy.manualProviderIds ?? policy.providerInstanceIds,
      requestedLocale: locale,
      providers,
    };
    return { saved };
  });
const selectRoute = (
  config: RuntimeConfiguration,
  options: {
    readonly input: PrepareInput;
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
            Effect.timeoutOrElse({
              duration: config.settings.selectorTimeoutMs,
              orElse: () => Effect.fail(new DomainError({ code: "temporarily_unavailable" })),
            }),
            Effect.mapError(() => new DomainError({ code: "temporarily_unavailable" })),
            Effect.ensuring(
              Effect.suspend(() => duration("selector", performance.now() - started)),
            ),
          );
    const route = yield* Schema.decodeUnknownEffect(SelectorResult)(selected, {
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
