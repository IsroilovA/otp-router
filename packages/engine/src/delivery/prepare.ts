import { constructProvider } from "../runtime/providers.js";
import { resolvePolicy, type PreparedRoute } from "../runtime/resolve.js";
import { Effect, Schema } from "effect";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { duration } from "../diagnostics/metrics.js";
import { SelectorResult, type RuntimeConfiguration } from "../config/config.js";
import { LocaleSchema, NormalizedPhoneSchema } from "../providers/contract.js";
import { DomainError } from "../errors.js";
import type { PrepareInput } from "./contracts.js";
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
export const prepareRoute = (
  config: RuntimeConfiguration,
  input: Omit<PrepareInput, "expiresAt">,
  projectId: string,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolvePolicy(config, projectId, input.policyId, input.purpose);
    const { policy } = resolved;
    const recipient = yield* Schema.decodeUnknownEffect(NormalizedPhoneSchema)(
      input.recipient.phoneNumber,
    );
    const locale = input.locale ?? policy.defaultLocale;
    const route = yield* selectRoute(config, {
      input,
      projectId,
      recipient,
      locale,
      permitted: resolved.providers.map(({ instance }) => instance.id),
      selectorId: policy.selectorId,
    });
    const locales = yield* Schema.decodeUnknownEffect(Schema.Array(LocaleSchema))([
      ...new Set([locale, ...policy.fallbackLocales]),
    ]);
    const providers = yield* Effect.forEach(route.providerInstanceIds, (id) =>
      Effect.gen(function* () {
        const entry = resolved.providers.find(({ instance }) => instance.id === id);
        if (entry === undefined)
          return yield* Effect.fail(new DomainError({ code: "delivery_unavailable" }));
        const { instance } = entry;
        if (instance.data.kind !== "instance")
          return yield* Effect.die(new Error("Invalid instance"));
        const provider = yield* constructProvider(entry.prepared);
        const template = yield* provider
          .resolveTemplate(locales)
          .pipe(Effect.mapError(() => new DomainError({ code: "delivery_unavailable" })));
        return {
          providerInstanceId: id,
          label: instance.data.settings.label,
          pluginId: provider.pluginId,
          contractVersion: provider.contractVersion,
          channel: provider.channel,
          resolvedLocale: template.locale,
          template: template.template,
          sendTimeoutMs: provider.sendTimeoutMs,
          minDeliveryWindowMs: provider.constraints.minDeliveryWindowMs,
          accountId: instance.data.accountId,
          instanceRevision: instance.configuration_revision,
          executionSettings: instance.data.settings,
          minCodeLength: provider.constraints.minCodeLength,
          maxCodeLength: provider.constraints.maxCodeLength,
          grantId: entry.grantId,
          accountEpoch: entry.accountEpoch,
          instanceEpoch: instance.epoch,
          manualSelectionAllowed: policy.manualProviderIds.includes(id),
        };
      }),
    );
    const saved: PreparedRoute = {
      policyId: input.policyId,
      policyRevision: resolved.revision,
      policyEpoch: resolved.epoch,
      policyGrantId: resolved.grantId,
      policy,
      maxSends: policy.maxSends,
      resendCooldownSeconds: policy.resendCooldownSeconds,
      manualSelectionEnabled: policy.manualSelectionEnabled,
      providers,
    };
    return { saved };
  }).pipe(Effect.scoped);
const selectRoute = (
  config: RuntimeConfiguration,
  options: {
    readonly projectId: string;
    readonly input: Omit<PrepareInput, "expiresAt">;
    readonly recipient: typeof NormalizedPhoneSchema.Type;
    readonly locale: string;
    readonly permitted: readonly string[];
    readonly selectorId: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const { input, recipient, locale, permitted } = options;
    const selector =
      options.selectorId === undefined ? undefined : config.selectors[options.selectorId];
    const started = performance.now();
    const selected =
      selector === undefined
        ? { _tag: "Route" as const, providerInstanceIds: permitted }
        : yield* selector
            .select({
              projectId: options.projectId,
              recipient,
              purpose: input.purpose,
              locale,
              routingContext: input.routingContext ?? {},
            })
            .pipe(
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
