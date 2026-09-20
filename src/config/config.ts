import { Context, Data, Effect, Layer, Schema } from "effect";
import { deliveryWindowFits } from "../providers/timing.js";
import { CryptoConfig, validateCrypto } from "../challenges/crypto.js";
import type { RoutingContext } from "../challenges/contracts.js";
import { Identifier, Locale } from "../challenges/contracts.js";
import {
  LocaleSchema,
  ProviderInstance,
  type NormalizedPhone,
  type ReadyProvider,
  type ProviderConfigurationError,
} from "../providers/contract.js";

const bounded = (min: number, max: number) =>
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: min, maximum: max })));
export const Policy = Schema.Struct({
  providerInstanceIds: Schema.Array(Identifier).pipe(Schema.check(Schema.isMinLength(1))),
  codeLength: bounded(6, 8).pipe(Schema.withDecodingDefaultType(Effect.succeed(6))),
  lifetimeSeconds: bounded(60, 600).pipe(Schema.withDecodingDefaultType(Effect.succeed(300))),
  maxIncorrectGuesses: bounded(1, 5).pipe(Schema.withDecodingDefaultType(Effect.succeed(5))),
  maxSends: bounded(1, 10).pipe(Schema.withDecodingDefaultType(Effect.succeed(6))),
  resendCooldownSeconds: bounded(30, 300).pipe(Schema.withDecodingDefaultType(Effect.succeed(30))),
  manualSelectionEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(false)),
  ),
  manualProviderIds: Schema.optional(Schema.Array(Identifier)),
});
export type Policy = typeof Policy.Type;
export const Settings = Schema.Struct({
  crypto: CryptoConfig,
  apiKeys: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMinLength(32)))).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(2)),
  ),
  defaultLocale: Locale,
  fallbackLocales: Schema.Array(Locale),
  policies: Schema.Record(Identifier, Policy),
  purposes: Schema.Record(
    Identifier,
    Schema.Array(Identifier).pipe(Schema.check(Schema.isMinLength(1))),
  ),
  deploymentSendLimit15m: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  deploymentSendLimit24h: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  recipientCreateLimit15m: bounded(1, 5).pipe(Schema.withDecodingDefaultType(Effect.succeed(5))),
  recipientSendLimit15m: bounded(1, 10).pipe(Schema.withDecodingDefaultType(Effect.succeed(10))),
  recipientGuessLimit15m: bounded(1, 10).pipe(Schema.withDecodingDefaultType(Effect.succeed(10))),
  providerSendLimits15m: Schema.Record(
    Identifier,
    Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  ).pipe(Schema.withDecodingDefaultType(Effect.succeed({}))),
  providerLabels: Schema.Record(
    Identifier,
    Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
  ).pipe(Schema.withDecodingDefaultType(Effect.succeed({}))),
  selectorTimeoutMs: bounded(1, 60000).pipe(Schema.withDecodingDefaultType(Effect.succeed(2000))),
  role: Schema.Literals(["combined", "api", "worker"]).pipe(
    Schema.withDecodingDefaultType(Effect.succeed("combined")),
  ),
  port: bounded(1, 65535).pipe(Schema.withDecodingDefaultType(Effect.succeed(3000))),
  internalPort: bounded(1, 65535).pipe(Schema.withDecodingDefaultType(Effect.succeed(3001))),
  host: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed("127.0.0.1"))),
  internalHost: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed("127.0.0.1"))),
  workerConcurrency: bounded(1, 64).pipe(Schema.withDecodingDefaultType(Effect.succeed(4))),
  shutdownGraceMs: bounded(1000, 120000).pipe(
    Schema.withDecodingDefaultType(Effect.succeed(30000)),
  ),
});
export type Settings = typeof Settings.Type;
export class SelectorFailure extends Data.TaggedError("SelectorFailure")<{}> {}
export const SelectorResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Reject") }),
  Schema.Struct({
    _tag: Schema.Literal("Route"),
    providerInstanceIds: Schema.Array(Identifier).pipe(Schema.check(Schema.isMinLength(1))),
  }),
]);
export type RoutingSelector = (input: {
  readonly recipient: NormalizedPhone;
  readonly purpose: string;
  readonly locale: string;
  readonly routingContext: typeof RoutingContext.Type;
}) => Effect.Effect<typeof SelectorResult.Type, SelectorFailure>;
export interface Configuration {
  readonly settings: typeof Settings.Encoded;
  readonly providers: readonly Layer.Layer<ProviderInstance, ProviderConfigurationError>[];
  readonly selectors?: Readonly<Record<string, RoutingSelector>>;
}
export const defineConfig = (configuration: Configuration): Configuration => configuration;
export interface RuntimeConfiguration {
  readonly settings: Settings;
  readonly providers: ReadonlyMap<string, ReadyProvider>;
  readonly selectors: Readonly<Record<string, RoutingSelector>>;
}
export const ConfigurationReason = Schema.Literals([
  "configuration_module_failed",
  "deployment_identity_changed",
  "incompatible_provider_constraints",
  "invalid_keys",
  "invalid_manual_allowlist",
  "invalid_policy",
  "invalid_provider_registration",
  "invalid_settings",
  "not_ready",
  "recipient_key_change_requires_invalidation_and_quota_wait",
  "recipient_key_changed_requires_incident_procedure",
  "retained_key_missing",
  "unknown_policy",
  "unknown_provider",
  "unknown_selector_policy",
  "unsupported_snapshot_version",
]);
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly reason: typeof ConfigurationReason.Type;
}> {}
export class RouterConfig extends Context.Service<RouterConfig, RuntimeConfiguration>()(
  "otp-router/Config",
) {}
const invalid = (reason: typeof ConfigurationReason.Type) =>
  Effect.fail(new ConfigurationError({ reason }));
const validatePolicy = (policy: Policy, providers: ReadonlyMap<string, ReadyProvider>) =>
  Effect.gen(function* () {
    if (
      policy.resendCooldownSeconds >= policy.lifetimeSeconds ||
      new Set(policy.providerInstanceIds).size !== policy.providerInstanceIds.length
    )
      return yield* invalid("invalid_policy");
    for (const id of policy.manualProviderIds ?? [])
      if (!policy.providerInstanceIds.includes(id))
        return yield* invalid("invalid_manual_allowlist");
    yield* validatePolicyProviders(policy, providers);
  });
export const loadConfiguration = (configuration: Configuration) =>
  Effect.gen(function* () {
    const settings = yield* Schema.decodeUnknownEffect(Settings)(configuration.settings, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new ConfigurationError({ reason: "invalid_settings" })));
    yield* validateCrypto(settings.crypto).pipe(
      Effect.mapError(() => new ConfigurationError({ reason: "invalid_keys" })),
    );
    const providers = yield* buildProviders(configuration);
    const locales = yield* Schema.decodeUnknownEffect(Schema.Array(LocaleSchema))([
      ...new Set([settings.defaultLocale, ...settings.fallbackLocales]),
    ]);
    for (const policy of Object.values(settings.policies)) {
      yield* validatePolicy(policy, providers);
      for (const id of policy.providerInstanceIds) {
        const provider = providers.get(id);
        if (provider !== undefined) yield* provider.resolveTemplate(locales);
      }
    }
    yield* validateReferences(settings, configuration);
    return {
      settings,
      providers,
      selectors: configuration.selectors ?? {},
    } satisfies RuntimeConfiguration;
  });

const validatePolicyProviders = (policy: Policy, providers: ReadonlyMap<string, ReadyProvider>) =>
  Effect.gen(function* () {
    for (const id of policy.providerInstanceIds) {
      const provider = providers.get(id);
      if (provider === undefined) return yield* invalid("unknown_provider");
      if (
        policy.codeLength < provider.constraints.minCodeLength ||
        policy.codeLength > provider.constraints.maxCodeLength ||
        !deliveryWindowFits(
          { ...provider.constraints, sendTimeoutMs: provider.sendTimeoutMs },
          policy.lifetimeSeconds * 1000,
        )
      )
        return yield* invalid("incompatible_provider_constraints");
    }
  });

const buildProviders = (configuration: Configuration) =>
  Effect.gen(function* () {
    const providers = new Map<string, ReadyProvider>();
    for (const layer of configuration.providers) {
      const provider = Context.get(yield* Layer.build(layer), ProviderInstance);
      if (
        providers.has(provider.instanceId) ||
        !Schema.is(Schema.Literal(1))(provider.contractVersion) ||
        !Number.isFinite(provider.sendTimeoutMs) ||
        provider.sendTimeoutMs <= 0 ||
        !Number.isFinite(provider.defaultSendTimeoutMs) ||
        provider.defaultSendTimeoutMs <= 0
      )
        return yield* invalid("invalid_provider_registration");
      providers.set(provider.instanceId, provider);
    }
    return providers;
  });

const validateReferences = (settings: Settings, configuration: Configuration) =>
  Effect.gen(function* () {
    for (const ids of Object.values(settings.purposes))
      for (const id of ids)
        if (settings.policies[id] === undefined) return yield* invalid("unknown_policy");
    for (const id of Object.keys(configuration.selectors ?? {}))
      if (settings.policies[id] === undefined) return yield* invalid("unknown_selector_policy");
  });
