import { Context, type Effect, Schema } from "effect";
import { Identifier, Locale, Opaque } from "../delivery/input.js";
import type { DomainError } from "../errors.js";

const bounded = (min: number, max: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }));
export const ManagedPolicy = Schema.Struct({
  codeLength: bounded(6, 8),
  lifetimeSeconds: bounded(60, 3600),
  maxIncorrectGuesses: bounded(1, 5),
});
export const Policy = Schema.Struct({
  providerInstanceIds: Schema.Array(Identifier).check(Schema.isMinLength(1)),
  purposes: Schema.Array(Identifier).check(Schema.isMinLength(1)),
  external: Schema.Boolean,
  managed: Schema.optionalKey(ManagedPolicy),
  maxLifetimeSeconds: bounded(60, 3600),
  maxSends: bounded(1, 10),
  resendCooldownSeconds: bounded(30, 300),
  manualSelectionEnabled: Schema.Boolean,
  manualProviderIds: Schema.Array(Identifier),
  fallback: Schema.Literals(["disabled", "confirmed_failure"]),
  defaultLocale: Locale,
  fallbackLocales: Schema.Array(Locale),
  selectorId: Schema.optionalKey(Identifier),
});
export type Policy = typeof Policy.Type;
export const Limits = Schema.Struct({
  sendLimit15m: bounded(1, 2147483647),
  sendLimit24h: bounded(1, 2147483647),
});
export const InstanceSettings = Schema.Struct({
  label: Schema.String.check(Schema.isMaxLength(128)),
  execution: Schema.Json,
  templates: Schema.Record(Locale, Schema.Json),
  sendTimeoutMs: bounded(1, 60000),
});
export const AccountData = Schema.Struct({
  kind: Schema.Literal("account"),
  adapterId: Identifier,
  schemaVersion: Schema.NonEmptyString,
  identity: Schema.Json,
  scopeIds: Schema.Array(Identifier),
});
export const InstanceData = Schema.Struct({
  kind: Schema.Literal("instance"),
  accountId: Identifier,
  settings: InstanceSettings,
  scopeIds: Schema.Array(Identifier),
});
export const PolicyData = Schema.Struct({ kind: Schema.Literal("policy"), settings: Policy });
export const ScopeData = Schema.Struct({ kind: Schema.Literal("scope"), limits: Limits });
export const ResourceData = Schema.Union([AccountData, InstanceData, PolicyData, ScopeData]);
export const ResourceKind = Schema.Literals(["account", "instance", "policy", "scope"]);
export const LifecycleKind = Schema.Literals(["account", "instance", "policy"]);
export const VersionedKind = Schema.Literals(["instance", "policy"]);
export const ResourceState = Schema.Literals(["disabled", "enabled", "retired"]);
const identity = { id: Identifier, revision: bounded(1, 2147483647) };
export const ResourceSnapshot = Schema.Union([
  Schema.Struct({
    ...identity,
    configurationRevision: bounded(1, 2147483647),
    epoch: bounded(1, 2147483647),
    state: ResourceState,
    data: Schema.Union([AccountData, InstanceData, PolicyData]),
    sendCredentialVersion: Schema.NullOr(Schema.String),
    callbackVersion: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...identity,
    data: ScopeData,
    state: Schema.optionalKey(Schema.Never),
    epoch: Schema.optionalKey(Schema.Never),
    configurationRevision: Schema.optionalKey(Schema.Never),
    sendCredentialVersion: Schema.optionalKey(Schema.Never),
    callbackVersion: Schema.optionalKey(Schema.Never),
  }),
]);
export const RuntimePermission = Schema.Literals([
  "read",
  "manage",
  "rotate",
  "policy",
  "assign",
  "audit",
]);
const target = { id: Identifier, expectedRevision: bounded(1, 2147483647) };
const firstInstance = Schema.Struct({
  id: Identifier,
  settings: InstanceSettings,
  scopeIds: Schema.Array(Identifier),
});
export const RuntimeCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create"),
    id: Identifier,
    data: AccountData,
    firstInstance: Schema.optionalKey(firstInstance),
  }),
  Schema.Struct({
    action: Schema.Literal("create"),
    id: Identifier,
    data: Schema.Union([InstanceData, PolicyData, ScopeData]),
    firstInstance: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    ...target,
    kind: Schema.Literal("instance"),
    settings: InstanceSettings,
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    ...target,
    kind: Schema.Literal("policy"),
    settings: Policy,
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    ...target,
    kind: Schema.Literal("scope"),
    settings: Limits,
  }),
  Schema.Struct({
    action: Schema.Literal("lifecycle"),
    ...target,
    kind: LifecycleKind,
    state: ResourceState,
  }),
  Schema.Struct({
    action: Schema.Literal("rotate"),
    ...target,
    kind: Schema.Literal("account"),
    purpose: Schema.Literals(["send", "callback"]),
    secrets: Schema.Json,
  }),
  Schema.Struct({
    action: Schema.Literal("revoke-secret"),
    ...target,
    kind: Schema.Literal("account"),
    versionId: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("invalidate"),
    ...target,
    kind: VersionedKind,
    revision: bounded(1, 2147483647),
  }),
  Schema.Struct({
    action: Schema.Literal("grant"),
    ...target,
    kind: Schema.Literal("account"),
    projectId: Identifier,
    allInstances: Schema.Literal(true),
  }),
  Schema.Struct({
    action: Schema.Literal("grant"),
    ...target,
    kind: VersionedKind,
    projectId: Identifier,
    allInstances: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    action: Schema.Literal("revoke"),
    ...target,
    kind: LifecycleKind,
    projectId: Identifier,
    allInstances: Schema.optionalKey(Schema.Never),
  }),
]);
export const RuntimeRequest = Schema.Struct({
  actorId: Identifier,
  key: Opaque,
  command: RuntimeCommand,
});
export const RuntimeResult = Schema.Struct({ body: ResourceSnapshot, replayed: Schema.Boolean });
export const Assignment = Schema.Struct({
  id: Schema.String,
  projectId: Identifier,
  kind: LifecycleKind,
  resourceId: Identifier,
  revoked: Schema.Boolean,
});
export const RuntimeAuditEvent = Schema.Struct({
  id: Schema.String,
  actorId: Identifier,
  action: Schema.String,
  kind: ResourceKind,
  resourceId: Identifier,
  revision: Schema.Int,
  occurredAt: Schema.String,
  projectId: Schema.NullOr(Identifier),
});
export const RuntimePageInput = Schema.Struct({
  after: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(bounded(1, 100)),
});
export const ResourcePage = Schema.Struct({
  resources: Schema.Array(ResourceSnapshot),
  nextCursor: Schema.NullOr(Schema.String),
});
export const RuntimeAuditPage = Schema.Struct({
  events: Schema.Array(RuntimeAuditEvent),
  nextCursor: Schema.NullOr(Schema.String),
});
export class RuntimeAdministration extends Context.Service<
  RuntimeAdministration,
  {
    readonly mutate: (
      request: typeof RuntimeRequest.Type,
    ) => Effect.Effect<typeof RuntimeResult.Type, DomainError>;
    readonly get: (
      actorId: string,
      kind: typeof ResourceKind.Type,
      id: string,
    ) => Effect.Effect<typeof ResourceSnapshot.Type, DomainError>;
    readonly list: (
      actorId: string,
      kind: typeof ResourceKind.Type,
      input: typeof RuntimePageInput.Type,
    ) => Effect.Effect<typeof ResourcePage.Type, DomainError>;
    readonly assignments: (
      actorId: string,
      projectId: string,
    ) => Effect.Effect<readonly (typeof Assignment.Type)[], DomainError>;
    readonly audit: (
      actorId: string,
      kind: typeof ResourceKind.Type,
      id: string,
      input: typeof RuntimePageInput.Type,
    ) => Effect.Effect<typeof RuntimeAuditPage.Type, DomainError>;
  }
>()("otp-router/RuntimeAdministration") {}
