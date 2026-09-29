import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { DomainError } from "../errors.js";
import type { AdminAction, AdminCommand, AdminPermissions, ProjectSettings } from "./contracts.js";

export const scoped = (permissions: typeof AdminPermissions.Type, id: string) =>
  permissions.projectIds.includes(id) ||
  permissions.creationPrefixes.some((prefix) => id.startsWith(prefix));
export const authorizeAdmin = (
  config: RuntimeConfiguration,
  actorId: string,
  action: typeof AdminAction.Type,
  id?: string,
) =>
  Effect.gen(function* () {
    const permissions = config.settings.administration.administrators[actorId];
    if (
      permissions === undefined ||
      !permissions.actions.includes(action) ||
      (id !== undefined && !scoped(permissions, id))
    )
      return yield* Effect.fail(new DomainError({ code: "admin_forbidden" }));
    return permissions;
  });
export const authorizeCommand = (
  config: RuntimeConfiguration,
  actorId: string,
  command: typeof AdminCommand.Type,
) =>
  Effect.gen(function* () {
    const id = command.action === "create" ? command.input.id : command.projectId;
    const permissions = yield* authorizeAdmin(config, actorId, command.action, id);
    const principals =
      command.action === "create"
        ? command.input.principalIds
        : command.action === "grant" || command.action === "revoke"
          ? [command.principalId]
          : [];
    if (
      principals.some(
        (principal) =>
          !permissions.grantablePrincipalIds.includes(principal) ||
          !config.settings.administration.principalIds.includes(principal),
      )
    )
      return yield* Effect.fail(new DomainError({ code: "admin_forbidden" }));
    const settings =
      command.action === "create"
        ? command.input.settings
        : command.action === "update"
          ? command.settings
          : undefined;
    if (settings !== undefined) yield* authorizeSettings(config, permissions, settings);
    return permissions;
  });
const authorizeSettings = (
  config: RuntimeConfiguration,
  permissions: typeof AdminPermissions.Type,
  settings: typeof ProjectSettings.Type,
) =>
  Effect.gen(function* () {
    if (
      settings.sendLimit15m > permissions.sendLimit15mCeiling ||
      settings.sendLimit24h > permissions.sendLimit24hCeiling ||
      (!settings.authorizationRequired &&
        (config.settings.administration.authorizationFloor || !permissions.mayDisableAuthorization))
    )
      return yield* Effect.fail(new DomainError({ code: "admin_forbidden" }));
    if (settings.authorizationRequired && config.authorizer === undefined)
      return yield* Effect.fail(new DomainError({ code: "invalid_request" }));
  });

export const authorizeSettingChanges = (
  permissions: typeof AdminPermissions.Type,
  before: typeof ProjectSettings.Type,
  after: typeof ProjectSettings.Type,
) =>
  Effect.gen(function* () {
    for (const field of ["authorizationRequired", "sendLimit15m", "sendLimit24h"] as const)
      if (before[field] !== after[field] && !permissions.editableSettings.includes(field))
        return yield* Effect.fail(new DomainError({ code: "admin_forbidden" }));
  });
