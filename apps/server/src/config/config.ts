import { Data, Effect, Schema } from "effect";
import {
  ConfigurationError,
  loadConfiguration as loadEngineConfiguration,
  type Configuration as EngineConfiguration,
} from "@otp-router/engine/config";
const bounded = (min: number, max: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }));
export const Principal = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/)),
  keys: Schema.Array(Schema.String.check(Schema.isMinLength(32))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2),
  ),
});
export const Principals = Schema.Array(Principal).check(
  Schema.isMinLength(1),
  Schema.makeFilter((values) => {
    const ids = values.map((value) => value.id);
    const keys = values.flatMap((value) => value.keys);
    return new Set(ids).size === ids.length && new Set(keys).size === keys.length;
  }),
);
export const Settings = Schema.Struct({
  databaseUrl: Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1))),
  principals: Principals,
  administrators: Principals,
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
export interface ConfigurationInput {
  readonly settings: typeof Settings.Encoded;
  readonly engine: EngineConfiguration;
}
export const defineConfig = (configuration: ConfigurationInput): ConfigurationInput =>
  configuration;
export class ApplicationConfigurationError extends Data.TaggedError(
  "ApplicationConfigurationError",
)<{
  readonly reason: "configuration_module_failed" | "invalid_settings" | "not_ready";
}> {}
export const loadConfiguration = (entry: ConfigurationInput) =>
  Effect.gen(function* () {
    const settings = yield* Schema.decodeUnknownEffect(Settings)(entry.settings, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() => new ApplicationConfigurationError({ reason: "invalid_settings" })),
    );
    const config = yield* loadEngineConfiguration(entry.engine);
    const configured = config.settings.administration;
    const sameIds = (actual: readonly string[], expected: readonly string[]) =>
      actual.length === expected.length && actual.every((id) => expected.includes(id));
    const credentials = [...settings.principals, ...settings.administrators].flatMap(
      (identity) => identity.keys,
    );
    if (
      !sameIds(
        settings.principals.map((p) => p.id),
        configured.principalIds,
      ) ||
      !sameIds(
        settings.administrators.map((p) => p.id),
        Object.keys(configured.administrators),
      ) ||
      new Set(credentials).size !== credentials.length
    )
      return yield* Effect.fail(new ApplicationConfigurationError({ reason: "invalid_settings" }));
    const webhook = config.settings.webhook;
    if (
      webhook !== undefined &&
      [...settings.principals, ...settings.administrators]
        .flatMap((principal) => principal.keys)
        .some(
          (key) =>
            key === webhook.signingSecret ||
            key === Buffer.from(webhook.signingSecret.slice(6), "base64").toString("base64"),
        )
    )
      return yield* Effect.fail(new ConfigurationError({ reason: "invalid_keys" }));
    return { settings, engine: config };
  });
