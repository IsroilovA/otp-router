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
export const ResourceData = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("account"),
    adapterId: Identifier,
    schemaVersion: Schema.NonEmptyString,
    identity: Schema.Json,
    scopeIds: Schema.Array(Identifier),
  }),
  Schema.Struct({
    kind: Schema.Literal("instance"),
    accountId: Identifier,
    settings: InstanceSettings,
    scopeIds: Schema.Array(Identifier),
  }),
  Schema.Struct({ kind: Schema.Literal("policy"), settings: Policy }),
  Schema.Struct({ kind: Schema.Literal("scope"), limits: Limits }),
]);
export const ResourceKind = Schema.Literals(["account", "instance", "policy", "scope"]);
export const ResourceState = Schema.Literals(["disabled", "enabled", "retired"]);
export const ResourceSnapshot = Schema.Struct({
  id: Identifier,
  revision: Schema.Int,
  configurationRevision: Schema.Int,
  epoch: Schema.Int,
  state: ResourceState,
  data: ResourceData,
  sendCredentialVersion: Schema.NullOr(Schema.String),
  callbackVersion: Schema.NullOr(Schema.String),
});
export const RuntimePermission = Schema.Literals([
  "read",
  "manage",
  "rotate",
  "policy",
  "assign",
  "audit",
]);
const target = { kind: ResourceKind, id: Identifier, expectedRevision: bounded(1, 2147483647) };
export const RuntimeCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create"),
    id: Identifier,
    data: ResourceData,
    firstInstance: Schema.optionalKey(
      Schema.Struct({
        id: Identifier,
        settings: InstanceSettings,
        scopeIds: Schema.Array(Identifier),
      }),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    ...target,
    settings: Schema.Union([InstanceSettings, Policy, Limits]),
  }),
  Schema.Struct({ action: Schema.Literal("lifecycle"), ...target, state: ResourceState }),
  Schema.Struct({
    action: Schema.Literal("rotate"),
    ...target,
    purpose: Schema.Literals(["send", "callback"]),
    secrets: Schema.Json,
  }),
  Schema.Struct({ action: Schema.Literal("revoke-secret"), ...target, versionId: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("invalidate"),
    ...target,
    revision: bounded(1, 2147483647),
  }),
  Schema.Struct({
    action: Schema.Literals(["grant", "revoke"]),
    ...target,
    projectId: Identifier,
    allInstances: Schema.optionalKey(Schema.Literal(true)),
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
  kind: ResourceKind,
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
