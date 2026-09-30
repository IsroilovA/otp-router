import { Context, Schema, type Effect } from "effect";
import { Identifier, Opaque } from "../delivery/input.js";
import type { DomainError } from "../errors.js";

export const ProjectSettings = Schema.Struct({
  authorizationRequired: Schema.Boolean,
  sendLimit15m: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 })),
  sendLimit24h: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2147483647 })),
});
export const AdminAction = Schema.Literals([
  "create",
  "read",
  "list",
  "update",
  "suspend",
  "reactivate",
  "retire",
  "grant",
  "revoke",
  "audit",
]);
export const AdminPermissions = Schema.Struct({
  runtimeActions: Schema.Array(
    Schema.Literals(["read", "manage", "rotate", "policy", "assign", "audit"]),
  ),
  resourceIds: Schema.Array(Identifier),
  resourcePrefixes: Schema.Array(Identifier),
  actions: Schema.Array(AdminAction),
  projectIds: Schema.Array(Identifier),
  creationPrefixes: Schema.Array(Identifier),
  grantablePrincipalIds: Schema.Array(Identifier),
  editableSettings: Schema.Array(
    Schema.Literals(["authorizationRequired", "sendLimit15m", "sendLimit24h"]),
  ),
  sendLimit15mCeiling: ProjectSettings.fields.sendLimit15m,
  sendLimit24hCeiling: ProjectSettings.fields.sendLimit24h,
  mayDisableAuthorization: Schema.Boolean,
});
export const Administration = Schema.Struct({
  principalIds: Schema.Array(Identifier).check(
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
  administrators: Schema.Record(Identifier, AdminPermissions),
  authorizationFloor: Schema.Boolean,
});
export const Grant = Schema.Struct({
  id: Schema.String,
  principalId: Identifier,
  grantedAt: Schema.String,
});
export const ProjectSnapshot = Schema.Struct({
  id: Identifier,
  state: Schema.Literals(["active", "suspended", "retired"]),
  revision: Schema.Int,
  settings: ProjectSettings,
  grants: Schema.Array(Grant),
  createdAt: Schema.String,
});
export const CreateProjectInput = Schema.Struct({
  id: Identifier,
  settings: ProjectSettings,
  principalIds: Schema.Array(Identifier).check(
    Schema.makeFilter((ids) => new Set(ids).size === ids.length),
  ),
});
export const ChangeDetails = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create"),
    settings: ProjectSettings,
    grants: Schema.Array(Grant),
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    before: ProjectSettings,
    after: ProjectSettings,
  }),
  Schema.Struct({
    action: Schema.Literals(["suspend", "reactivate", "retire"]),
    before: ProjectSnapshot.fields.state,
    after: ProjectSnapshot.fields.state,
  }),
  Schema.Struct({
    action: Schema.Literals(["grant", "revoke"]),
    grantId: Schema.String,
    principalId: Identifier,
  }),
]);
export const AdminEvent = Schema.Struct({
  id: Schema.String,
  projectId: Identifier,
  actorId: Identifier,
  action: AdminAction,
  occurredAt: Schema.String,
  revision: Schema.Int,
  details: ChangeDetails,
});
export const PageInput = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export const ProjectPage = Schema.Struct({
  projects: Schema.Array(ProjectSnapshot),
  nextCursor: Schema.NullOr(Schema.String),
});
export const AuditPage = Schema.Struct({
  events: Schema.Array(AdminEvent),
  nextCursor: Schema.NullOr(Schema.String),
});
const target = {
  projectId: Identifier,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
};
export const AdminCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("create"), input: CreateProjectInput }),
  Schema.Struct({ action: Schema.Literal("update"), ...target, settings: ProjectSettings }),
  Schema.Struct({ action: Schema.Literals(["suspend", "reactivate", "retire"]), ...target }),
  Schema.Struct({
    action: Schema.Literals(["grant", "revoke"]),
    ...target,
    principalId: Identifier,
  }),
]);
export const AdminRequest = Schema.Struct({
  actorId: Identifier,
  key: Opaque,
  command: AdminCommand,
});
export const AdminResult = Schema.Struct({
  status: Schema.Literals([200, 201]),
  body: ProjectSnapshot,
  replayed: Schema.Boolean,
});
export class Projects extends Context.Service<
  Projects,
  {
    readonly mutate: (
      request: typeof AdminRequest.Type,
    ) => Effect.Effect<typeof AdminResult.Type, DomainError>;
    readonly get: (
      actorId: string,
      projectId: string,
    ) => Effect.Effect<typeof ProjectSnapshot.Type, DomainError>;
    readonly list: (
      actorId: string,
      input: typeof PageInput.Type,
    ) => Effect.Effect<typeof ProjectPage.Type, DomainError>;
    readonly audit: (
      actorId: string,
      projectId: string,
      input: typeof PageInput.Type,
    ) => Effect.Effect<typeof AuditPage.Type, DomainError>;
  }
>()("otp-router/Projects") {}
