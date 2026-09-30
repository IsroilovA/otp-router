import { Effect, Schema } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { DomainError } from "../errors.js";
import { deliveryWindowFits } from "../providers/timing.js";
import { type Policy, type ResourceData, type RuntimeCommand } from "./contracts.js";
import { providerConfiguration } from "./providers.js";
import { type ResourceRecord, resource } from "./store.js";

export const invalidRuntime = () => new DomainError({ code: "invalid_request" });
export const validateJson = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.asVoid,
    Effect.mapError(invalidRuntime),
  );
const accountAdapter = (
  config: RuntimeConfiguration,
  data: Extract<typeof ResourceData.Type, { kind: "account" }>,
) => {
  const adapter = config.adapters.get(data.adapterId);
  return adapter === undefined || adapter.schemaVersion !== data.schemaVersion
    ? Effect.fail(invalidRuntime())
    : Effect.succeed(adapter);
};
const validateInstance = (
  config: RuntimeConfiguration,
  data: Extract<typeof ResourceData.Type, { kind: "instance" }>,
) =>
  Effect.gen(function* () {
    const account = yield* resource("account", data.accountId);
    if (account.data.kind !== "account" || account.state === "retired")
      return yield* Effect.fail(invalidRuntime());
    const adapter = yield* accountAdapter(config, account.data);
    yield* validateJson(adapter.executionSchema, data.settings.execution);
    if (adapter.templateSchema !== null)
      for (const template of Object.values(data.settings.templates))
        yield* validateJson(adapter.templateSchema, template);
  });
const validatePolicyProviders = (config: RuntimeConfiguration, policy: Policy) =>
  Effect.gen(function* () {
    for (const id of policy.providerInstanceIds) {
      const instance = yield* resource("instance", id);
      if (instance.data.kind !== "instance") return yield* Effect.fail(invalidRuntime());
      const account = yield* resource("account", instance.data.accountId);
      if (account.data.kind !== "account") return yield* Effect.fail(invalidRuntime());
      const adapter = yield* accountAdapter(config, account.data);
      if (
        !deliveryWindowFits(
          { ...adapter.constraints, sendTimeoutMs: instance.data.settings.sendTimeoutMs },
          (policy.managed?.lifetimeSeconds ?? policy.maxLifetimeSeconds) * 1000,
        )
      )
        return yield* Effect.fail(invalidRuntime());
      if (
        policy.managed !== undefined &&
        (policy.managed.codeLength < adapter.constraints.minCodeLength ||
          policy.managed.codeLength > adapter.constraints.maxCodeLength)
      )
        return yield* Effect.fail(invalidRuntime());
      const templates = instance.data.settings.templates;
      if (
        adapter.templateSchema !== null &&
        ![policy.defaultLocale, ...policy.fallbackLocales].some((locale) =>
          Object.hasOwn(templates, locale),
        )
      )
        return yield* Effect.fail(invalidRuntime());
    }
  });
const validatePolicy = (config: RuntimeConfiguration, policy: Policy) =>
  Effect.gen(function* () {
    if (
      new Set(policy.providerInstanceIds).size !== policy.providerInstanceIds.length ||
      policy.resendCooldownSeconds >= policy.maxLifetimeSeconds ||
      (!policy.external && policy.managed === undefined) ||
      policy.manualProviderIds.some((id) => !policy.providerInstanceIds.includes(id)) ||
      (policy.selectorId !== undefined && !config.selectors.has(policy.selectorId))
    )
      return yield* Effect.fail(invalidRuntime());
    if (
      policy.managed !== undefined &&
      (config.settings.crypto.verification === undefined ||
        policy.managed.lifetimeSeconds > policy.maxLifetimeSeconds ||
        policy.managed.lifetimeSeconds <= policy.resendCooldownSeconds)
    )
      return yield* Effect.fail(invalidRuntime());
    yield* validatePolicyProviders(config, policy);
  });
export const validateData = (config: RuntimeConfiguration, data: typeof ResourceData.Type) =>
  Effect.gen(function* () {
    switch (data.kind) {
      case "account":
        yield* validateJson((yield* accountAdapter(config, data)).identitySchema, data.identity);
        break;
      case "instance":
        yield* validateInstance(config, data);
        break;
      case "policy":
        yield* validatePolicy(config, data.settings);
        break;
      case "scope":
        break;
    }
    if (data.kind === "account" || data.kind === "instance") {
      if (new Set(data.scopeIds).size !== data.scopeIds.length)
        return yield* Effect.fail(invalidRuntime());
      for (const id of data.scopeIds) yield* resource("scope", id);
    }
  });
export const updatedData = (
  before: ResourceRecord,
  command: Extract<typeof RuntimeCommand.Type, { action: "update" }>,
) =>
  Effect.gen(function* () {
    switch (command.kind) {
      case "instance":
        if (before.data.kind !== "instance")
          return yield* Effect.die(new Error("Invalid instance"));
        return { ...before.data, settings: command.settings };
      case "policy":
        return { kind: "policy" as const, settings: command.settings };
      case "scope":
        return { kind: "scope" as const, limits: command.settings };
    }
  });
export const validateEnable = (config: RuntimeConfiguration, record: ResourceRecord) =>
  Effect.gen(function* () {
    yield* validateData(config, record.data);
    if (record.data.kind === "account" && record.send_version === null)
      return yield* Effect.fail(invalidRuntime());
    if (record.data.kind === "instance")
      yield* providerConfiguration(config, yield* resource("account", record.data.accountId), {
        instanceId: record.id,
        revision: record.configuration_revision,
        settings: record.data.settings,
      }).pipe(Effect.mapError(invalidRuntime));
  });
