import { Context, Data, Effect, Layer, Schema } from "effect";
import { CryptoConfig, validateCrypto } from "../crypto.js";
import {
  type AuthorizationUnavailable,
  SendAuthorizer,
} from "../delivery/authorization-contracts.js";
import type { RoutingContext } from "../delivery/input.js";
import { Identifier } from "../delivery/input.js";
import { Administration } from "../projects/contracts.js";
import type { NormalizedPhone, ProviderDefinition } from "../providers/contract.js";
import { capabilityFingerprint } from "./capabilities.js";

const bounded = (min: number, max: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }));
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
  deploymentSendLimit15m: bounded(1, 2147483647),
  deploymentSendLimit24h: bounded(1, 2147483647),
  recipientCreateLimit15m: bounded(1, 5).pipe(Schema.withDecodingDefaultType(Effect.succeed(5))),
  recipientSendLimit15m: bounded(1, 10).pipe(Schema.withDecodingDefaultType(Effect.succeed(10))),
  recipientGuessLimit15m: bounded(1, 10).pipe(Schema.withDecodingDefaultType(Effect.succeed(10))),
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
  readonly adapters: readonly ProviderDefinition[];
  readonly selectors?: Readonly<
    Record<string, { readonly version: string; readonly select: RoutingSelector }>
  >;
}
export interface RuntimeConfiguration {
  readonly capabilityFingerprint: string;
  readonly authorizer?: Context.Service.Shape<typeof SendAuthorizer>;
  readonly settings: Settings;
  readonly adapters: ReadonlyMap<string, ProviderDefinition>;
  readonly selectors: ReadonlyMap<
    string,
    { readonly version: string; readonly select: RoutingSelector }
  >;
}
export const ConfigurationReason = Schema.Literals([
  "deployment_identity_changed",
  "incompatible_capabilities",
  "invalid_keys",
  "invalid_provider_registration",
  "invalid_settings",
  "recipient_key_change_requires_invalidation_and_quota_wait",
  "recipient_key_changed_requires_incident_procedure",
  "retained_key_missing",
]);
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly reason: typeof ConfigurationReason.Type;
}> {}
const invalid = (reason: typeof ConfigurationReason.Type) =>
  Effect.fail(new ConfigurationError({ reason }));
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
    const adapters = new Map(configuration.adapters.map((adapter) => [adapter.id, adapter]));
    if (
      adapters.size !== configuration.adapters.length ||
      configuration.adapters.some(
        (adapter) =>
          !Schema.is(Identifier)(adapter.id) ||
          adapter.version.length === 0 ||
          !Schema.is(Schema.Literal(2))(adapter.contractVersion) ||
          adapter.schemaVersion.length === 0 ||
          !Number.isSafeInteger(adapter.defaultSendTimeoutMs) ||
          adapter.defaultSendTimeoutMs <= 0 ||
          !Number.isSafeInteger(adapter.constraints.minCodeLength) ||
          adapter.constraints.minCodeLength < 1 ||
          !Number.isSafeInteger(adapter.constraints.maxCodeLength) ||
          adapter.constraints.maxCodeLength < adapter.constraints.minCodeLength ||
          !Number.isSafeInteger(adapter.constraints.minDeliveryWindowMs) ||
          adapter.constraints.minDeliveryWindowMs < 0,
      )
    )
      return yield* invalid("invalid_provider_registration");
    for (const [id, selector] of Object.entries(configuration.selectors ?? {}))
      if (!Schema.is(Identifier)(id) || selector.version.length === 0)
        return yield* invalid("invalid_settings");
    for (const permissions of Object.values(settings.administration.administrators))
      if (
        permissions.grantablePrincipalIds.some(
          (id) => !settings.administration.principalIds.includes(id),
        )
      )
        return yield* invalid("invalid_settings");
    const runtime = {
      settings,
      adapters,
      selectors: new Map(Object.entries(configuration.selectors ?? {})),
      ...(authorizer === undefined ? {} : { authorizer }),
    };
    return {
      ...runtime,
      capabilityFingerprint: capabilityFingerprint(runtime),
    } satisfies RuntimeConfiguration;
  });
