import { catalogFingerprint } from "./catalog.js";
import { Administration } from "../projects/contracts.js";
import {
  SendAuthorizer,
  type AuthorizationUnavailable,
} from "../delivery/authorization-contracts.js";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { deliveryWindowFits } from "../providers/timing.js";
import { CryptoConfig, validateCrypto } from "../crypto.js";
import type { RoutingContext } from "../delivery/input.js";
import { Identifier, Locale } from "../delivery/input.js";
import {
  LocaleSchema,
  ProviderInstance,
  type NormalizedPhone,
  type ReadyProvider,
  type ProviderConfigurationError,
} from "../providers/contract.js";

const bounded = (min: number, max: number) =>
  Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: min, maximum: max })));
export const ManagedPolicy = Schema.Struct({
  codeLength: bounded(6, 8).pipe(Schema.withDecodingDefaultType(Effect.succeed(6))),
  lifetimeSeconds: bounded(60, 3600).pipe(Schema.withDecodingDefaultType(Effect.succeed(300))),
  maxIncorrectGuesses: bounded(1, 5).pipe(Schema.withDecodingDefaultType(Effect.succeed(5))),
});
export const Policy = Schema.Struct({
  providerInstanceIds: Schema.Array(Identifier).check(Schema.isMinLength(1)),
  maxLifetimeSeconds: bounded(60, 3600).pipe(Schema.withDecodingDefaultType(Effect.succeed(900))),
  maxSends: bounded(1, 10).pipe(Schema.withDecodingDefaultType(Effect.succeed(6))),
  resendCooldownSeconds: bounded(30, 300).pipe(Schema.withDecodingDefaultType(Effect.succeed(30))),
  manualSelectionEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(false)),
  ),
  manualProviderIds: Schema.optionalKey(Schema.Array(Identifier)),
  managed: Schema.optionalKey(ManagedPolicy),
});
export type Policy = typeof Policy.Type;
export const Settings = Schema.Struct({
  crypto: CryptoConfig,
  administration: Administration,
  historyRetentionDays: bounded(1, 3650).pipe(Schema.withDecodingDefaultType(Effect.succeed(30))),
  webhook: Schema.optionalKey(
    Schema.Struct({
      url: Schema.String.check(
        Schema.makeFilter((value) => {
          try {
            const url = new URL(value);
            return (
              url.username === "" &&
              url.password === "" &&
              url.hash === "" &&
              (url.protocol === "https:" ||
                (url.protocol === "http:" &&
                  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
            );
          } catch {
            return false;
          }
        }),
      ),
      signingSecret: Schema.String.check(Schema.isPattern(/^whsec_[A-Za-z0-9+/]{43}=$/)),
    }),
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
  readonly projectId: string;
  readonly recipient: NormalizedPhone;
  readonly purpose: string;
  readonly locale: string;
  readonly routingContext: typeof RoutingContext.Type;
}) => Effect.Effect<typeof SelectorResult.Type, SelectorFailure>;
export interface Configuration {
  readonly authorizer?: Layer.Layer<SendAuthorizer, AuthorizationUnavailable>;
  readonly settings: typeof Settings.Encoded;
  readonly providers: readonly Layer.Layer<ProviderInstance, ProviderConfigurationError>[];
  readonly selectors?: Readonly<Record<string, RoutingSelector>>;
}
export interface RuntimeConfiguration {
  readonly catalogFingerprint: string;
  readonly authorizer?: Context.Service.Shape<typeof SendAuthorizer>;
  readonly settings: Settings;
  readonly providers: ReadonlyMap<string, ReadyProvider>;
  readonly selectors: Readonly<Record<string, RoutingSelector>>;
}
export const ConfigurationReason = Schema.Literals([
  "deployment_identity_changed",
  "incompatible_catalog",
  "incompatible_provider_constraints",
  "invalid_keys",
  "invalid_manual_allowlist",
  "invalid_policy",
  "invalid_provider_registration",
  "invalid_settings",
  "recipient_key_change_requires_invalidation_and_quota_wait",
  "recipient_key_changed_requires_incident_procedure",
  "retained_key_missing",
  "unknown_policy",
  "unknown_provider",
  "unknown_selector_policy",
]);
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly reason: typeof ConfigurationReason.Type;
}> {}
const invalid = (reason: typeof ConfigurationReason.Type) =>
  Effect.fail(new ConfigurationError({ reason }));
const validatePolicy = (policy: Policy, providers: ReadonlyMap<string, ReadyProvider>) =>
  Effect.gen(function* () {
    if (
      policy.resendCooldownSeconds >= policy.maxLifetimeSeconds ||
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
    if (settings.webhook !== undefined) {
      const secret = Buffer.from(settings.webhook.signingSecret.slice(6), "base64");
      const cryptoKeys = [
        settings.crypto.recipientKey,
        ...Object.values(settings.crypto.encryption.keys),
        ...Object.values(settings.crypto.verification?.keys ?? {}),
        ...Object.values(settings.crypto.fingerprint.keys),
      ];
      if (cryptoKeys.some((key) => secret.equals(Buffer.from(key, "base64url"))))
        return yield* invalid("invalid_keys");
    }
    const authorizer =
      configuration.authorizer === undefined
        ? undefined
        : Context.get(
            yield* Layer.build(configuration.authorizer).pipe(
              Effect.mapError(() => new ConfigurationError({ reason: "invalid_settings" })),
            ),
            SendAuthorizer,
          );
    if (settings.administration.authorizationFloor && authorizer === undefined)
      return yield* invalid("invalid_settings");
    const providers = yield* buildProviders(configuration);
    const locales = yield* Schema.decodeUnknownEffect(Schema.Array(LocaleSchema))([
      ...new Set([settings.defaultLocale, ...settings.fallbackLocales]),
    ]);
    for (const policy of Object.values(settings.policies)) {
      yield* validatePolicy(policy, providers);
      yield* validateManagedPolicy(policy, settings.crypto.verification !== undefined);
      for (const id of policy.providerInstanceIds) {
        const provider = providers.get(id);
        if (provider !== undefined) yield* provider.resolveTemplate(locales);
      }
    }
    yield* validateReferences(settings, configuration, providers);
    const runtime = {
      settings,
      providers,
      selectors: configuration.selectors ?? {},
      ...(authorizer === undefined ? {} : { authorizer }),
    };
    return {
      ...runtime,
      catalogFingerprint: catalogFingerprint(runtime),
    } satisfies RuntimeConfiguration;
  });

const validatePolicyProviders = (policy: Policy, providers: ReadonlyMap<string, ReadyProvider>) =>
  Effect.gen(function* () {
    for (const id of policy.providerInstanceIds) {
      const provider = providers.get(id);
      if (provider === undefined) return yield* invalid("unknown_provider");
      if (
        (policy.managed !== undefined &&
          (policy.managed.codeLength < provider.constraints.minCodeLength ||
            policy.managed.codeLength > provider.constraints.maxCodeLength)) ||
        !deliveryWindowFits(
          { ...provider.constraints, sendTimeoutMs: provider.sendTimeoutMs },
          (policy.managed?.lifetimeSeconds ?? policy.maxLifetimeSeconds) * 1000,
        )
      )
        return yield* invalid("incompatible_provider_constraints");
    }
  });

const validProviderConstraints = (provider: ReadyProvider): boolean => {
  const { minCodeLength, maxCodeLength, minDeliveryWindowMs } = provider.constraints;
  return (
    Number.isSafeInteger(minCodeLength) &&
    minCodeLength > 0 &&
    Number.isSafeInteger(maxCodeLength) &&
    maxCodeLength >= minCodeLength &&
    Number.isSafeInteger(minDeliveryWindowMs) &&
    minDeliveryWindowMs >= 0
  );
};

const buildProviders = (configuration: Configuration) =>
  Effect.gen(function* () {
    const providers = new Map<string, ReadyProvider>();
    for (const layer of configuration.providers) {
      const provider = Context.get(yield* Layer.build(layer), ProviderInstance);
      if (
        providers.has(provider.instanceId) ||
        !Schema.is(Schema.Literal(1))(provider.contractVersion) ||
        !Number.isSafeInteger(provider.sendTimeoutMs) ||
        provider.sendTimeoutMs <= 0 ||
        !Number.isSafeInteger(provider.defaultSendTimeoutMs) ||
        provider.defaultSendTimeoutMs <= 0 ||
        !validProviderConstraints(provider)
      )
        return yield* invalid("invalid_provider_registration");
      providers.set(provider.instanceId, provider);
    }
    return providers;
  });

const validateReferences = (
  settings: Settings,
  configuration: Configuration,
  providers: ReadonlyMap<string, ReadyProvider>,
) =>
  Effect.gen(function* () {
    for (const permissions of Object.values(settings.administration.administrators))
      if (
        permissions.grantablePrincipalIds.some(
          (id) => !settings.administration.principalIds.includes(id),
        )
      )
        return yield* invalid("invalid_settings");
    for (const ids of Object.values(settings.purposes))
      for (const id of ids)
        if (settings.policies[id] === undefined) return yield* invalid("unknown_policy");
    for (const id of Object.keys(configuration.selectors ?? {}))
      if (settings.policies[id] === undefined) return yield* invalid("unknown_selector_policy");
    for (const id of [
      ...Object.keys(settings.providerSendLimits15m),
      ...Object.keys(settings.providerLabels),
    ])
      if (!providers.has(id)) return yield* invalid("unknown_provider");
  });

const validateManagedPolicy = (policy: Policy, hasVerification: boolean) =>
  Effect.gen(function* () {
    if (
      policy.managed !== undefined &&
      (!hasVerification ||
        policy.managed.lifetimeSeconds > policy.maxLifetimeSeconds ||
        policy.managed.lifetimeSeconds <= policy.resendCooldownSeconds)
    )
      return yield* invalid("invalid_policy");
  });
