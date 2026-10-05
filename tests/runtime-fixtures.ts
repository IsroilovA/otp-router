import { createHash } from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
import {
  loadConfiguration,
  type Configuration,
  type RoutingSelector,
} from "../packages/engine/src/config/config.js";
import {
  ProviderInstance,
  type ProviderConfigurationError,
  type ProviderDefinition,
  type ReadyProvider,
} from "../packages/engine/src/providers/contract.js";
import {
  type RuntimeAdministration,
  type Policy,
} from "../packages/engine/src/runtime/contracts.js";

export interface FixtureConfiguration extends Omit<Configuration, "adapters" | "selectors"> {
  readonly adapters?: readonly ProviderDefinition[];
  readonly providerFixtures: readonly Layer.Layer<ProviderInstance, ProviderConfigurationError>[];
  readonly fixtures: {
    readonly defaultLocale?: string;
    readonly fallbackLocales?: readonly string[];
    readonly policies: Readonly<
      Record<
        string,
        Partial<Omit<Policy, "managed">> & {
          readonly providerInstanceIds: readonly string[];
          readonly managed?: Partial<NonNullable<Policy["managed"]>>;
        }
      >
    >;
    readonly purposes?: Readonly<Record<string, readonly string[]>>;
    readonly providerLabels?: Readonly<Record<string, string>>;
    readonly providerSendLimits15m?: Readonly<Record<string, number>>;
  };
  readonly selectors?: Readonly<Record<string, RoutingSelector>>;
}
// Test transports are substituted at the adapter boundary; production resolution,
// administration, encryption, assignments, snapshots, and dispatch run unchanged.
export const fixtureAdapters = (
  providers: ReadonlyMap<string, ReadyProvider>,
): ReadonlyMap<string, ProviderDefinition> =>
  new Map(
    [...providers].map(([id, provider]) => [
      id,
      {
        ...provider,
        id,
        schemaVersion: "1",
        identitySchema: Schema.Struct({}),
        secretsSchema: Schema.Struct({}),
        callbackSecretsSchema: Schema.Struct({}),
        executionSchema: Schema.Struct({}),
        templateSchema: null,
        makeCallback: () => Effect.succeed(undefined),
        make: (options) =>
          Layer.succeed(ProviderInstance, {
            ...provider,
            instanceId: options.instanceId,
            revision: options.revision,
            sendTimeoutMs: options.sendTimeoutMs ?? provider.sendTimeoutMs,
          }),
      },
    ]),
  );
export const fixtureProviders = (configuration: FixtureConfiguration) =>
  Effect.gen(function* () {
    const providers = new Map<string, ReadyProvider>();
    for (const layer of configuration.providerFixtures) {
      const provider = Context.get(yield* Layer.build(layer), ProviderInstance);
      providers.set(provider.instanceId, provider);
    }
    return providers;
  });
export const fixturePolicies = (
  configuration: FixtureConfiguration,
): Readonly<Record<string, Policy>> =>
  Object.fromEntries(
    Object.entries(configuration.fixtures.policies).map(([id, { managed, ...policy }]) => [
      id,
      {
        maxLifetimeSeconds: 900,
        maxSends: 6,
        resendCooldownSeconds: 30,
        manualSelectionEnabled: false,
        manualProviderIds: policy.providerInstanceIds,
        fallback: "confirmed_failure",
        external: true,
        defaultLocale: configuration.fixtures.defaultLocale ?? "en",
        fallbackLocales: configuration.fixtures.fallbackLocales ?? [],
        purposes: Object.entries(configuration.fixtures.purposes ?? { login: [id] })
          .filter(([, ids]) => ids.includes(id))
          .map(([purpose]) => purpose),
        ...policy,
        ...(managed === undefined
          ? {}
          : {
              managed: { codeLength: 6, lifetimeSeconds: 300, maxIncorrectGuesses: 5, ...managed },
            }),
        ...(configuration.selectors?.[id] === undefined ? {} : { selectorId: id }),
      },
    ]),
  );
export const loadFixtureConfiguration = (configuration: FixtureConfiguration) =>
  Effect.gen(function* () {
    const providers = yield* fixtureProviders(configuration);
    return yield* loadConfiguration({
      ...configuration,
      adapters: [...fixtureAdapters(providers).values(), ...(configuration.adapters ?? [])],
      selectors: Object.fromEntries(
        Object.entries(configuration.selectors ?? {}).map(([id, select]) => [
          id,
          { version: "1", select },
        ]),
      ),
    });
  });
export const provisionFixtures = (
  administration: Context.Service.Shape<typeof RuntimeAdministration>,
  providers: ReadonlyMap<string, ReadyProvider>,
  policies: Readonly<Record<string, Policy>>,
  options: FixtureConfiguration["fixtures"],
) =>
  Effect.gen(function* () {
    const mutate = (command: Parameters<typeof administration.mutate>[0]["command"]) =>
      administration.mutate({
        actorId: "admin",
        key: `fixture:${createHash("sha256").update(JSON.stringify(command)).digest("hex")}`,
        command,
      });
    for (const [id, provider] of providers) {
      yield* mutate({
        action: "create",
        id,
        data: {
          kind: "scope",
          limits: {
            sendLimit15m: options.providerSendLimits15m?.[id] ?? 1000000,
            sendLimit24h: 1000000,
          },
        },
      });
      yield* mutate({
        action: "create",
        id,
        data: { kind: "account", adapterId: id, schemaVersion: "1", identity: {}, scopeIds: [id] },
        firstInstance: {
          id,
          settings: {
            label: options.providerLabels?.[id] ?? provider.channel,
            execution: {},
            templates: {},
            sendTimeoutMs: provider.sendTimeoutMs,
          },
          scopeIds: [],
        },
      });
      const rotated = yield* mutate({
        action: "rotate",
        kind: "account",
        id,
        expectedRevision: 1,
        purpose: "send",
        secrets: {},
      });
      const callback = yield* mutate({
        action: "rotate",
        kind: "account",
        id,
        expectedRevision: rotated.body.revision,
        purpose: "callback",
        secrets: {},
      });
      yield* mutate({
        action: "lifecycle",
        kind: "account",
        id,
        expectedRevision: callback.body.revision,
        state: "enabled",
      });
      yield* mutate({
        action: "lifecycle",
        kind: "instance",
        id,
        expectedRevision: 1,
        state: "enabled",
      });
    }
    for (const [id, settings] of Object.entries(policies)) {
      yield* mutate({ action: "create", id, data: { kind: "policy", settings } });
      yield* mutate({
        action: "lifecycle",
        kind: "policy",
        id,
        expectedRevision: 1,
        state: "enabled",
      });
    }
    for (const projectId of ["demo", "alpha", "beta"])
      for (const [kind, ids] of [
        ["instance", [...providers.keys()]],
        ["policy", Object.keys(policies)],
      ] as const)
        for (const id of ids) {
          const before = yield* administration.get("admin", kind, id);
          yield* mutate({
            action: "grant",
            kind,
            id,
            projectId,
            expectedRevision: before.revision,
          });
        }
  });
