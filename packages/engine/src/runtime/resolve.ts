import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { assertCapabilities } from "../config/deployment.js";
import { canonical } from "../crypto.js";
import { transaction } from "../database/transaction.js";
import type { PolicySnapshot } from "../delivery/records.js";
import { DomainError } from "../errors.js";
import { providerConfiguration } from "./providers.js";
import { activeGrant, instanceAuthority, resource, revisionValid } from "./store.js";

export const resolvePolicy = (
  config: RuntimeConfiguration,
  projectId: string,
  policyId: string,
  purpose: string,
) =>
  transaction(
    Effect.gen(function* () {
      yield* assertCapabilities(config).pipe(
        Effect.mapError(() => new DomainError({ code: "temporarily_unavailable" })),
      );
      const record = yield* resource("policy", policyId).pipe(
        Effect.catchTag("DomainError", () =>
          Effect.fail(new DomainError({ code: "policy_not_allowed" })),
        ),
      );
      const grantId = yield* activeGrant(projectId, "policy", policyId);
      if (
        record.data.kind !== "policy" ||
        record.state !== "enabled" ||
        grantId === undefined ||
        !record.data.settings.purposes.includes(purpose) ||
        !(yield* revisionValid("policy", policyId, record.configuration_revision))
      )
        return yield* Effect.fail(new DomainError({ code: "policy_not_allowed" }));
      const policy = record.data.settings;
      const providers = [];
      for (const id of policy.providerInstanceIds) {
        const authority = yield* instanceAuthority(projectId, id);
        if (
          authority === undefined ||
          !(yield* revisionValid("instance", id, authority.instance.configuration_revision))
        )
          continue;
        const instance = authority.instance;
        if (instance.data.kind !== "instance")
          return yield* Effect.die(new Error("Invalid instance"));
        const prepared = yield* providerConfiguration(config, authority.account, {
          instanceId: id,
          revision: instance.configuration_revision,
          settings: instance.data.settings,
        }).pipe(Effect.mapError(() => new DomainError({ code: "delivery_unavailable" })));
        providers.push({
          instance,
          prepared,
          grantId: authority.grantId,
          accountEpoch: authority.account.epoch,
        });
      }
      if (providers.length === 0)
        return yield* Effect.fail(new DomainError({ code: "delivery_unavailable" }));
      return {
        policy,
        revision: record.configuration_revision,
        epoch: record.epoch,
        grantId,
        providers,
      };
    }),
  );
export const revalidateRoute = (
  projectId: string,
  saved: Omit<PolicySnapshot, "authorizationRequired">,
) =>
  Effect.gen(function* () {
    const policy = yield* resource("policy", saved.policyId);
    if (
      policy.configuration_revision !== saved.policyRevision ||
      policy.epoch !== saved.policyEpoch ||
      policy.state !== "enabled" ||
      (yield* activeGrant(projectId, "policy", saved.policyId)) !== saved.policyGrantId ||
      !(yield* revisionValid("policy", saved.policyId, saved.policyRevision))
    )
      return yield* Effect.fail(new DomainError({ code: "policy_not_allowed" }));
    for (const step of saved.providers) {
      const current = yield* instanceAuthority(projectId, step.providerInstanceId, step.grantId);
      if (
        current === undefined ||
        current.instance.configuration_revision !== step.instanceRevision ||
        current.instance.epoch !== step.instanceEpoch ||
        current.account.epoch !== step.accountEpoch ||
        current.grantId !== step.grantId ||
        !(yield* revisionValid("instance", step.providerInstanceId, step.instanceRevision)) ||
        current.instance.data.kind !== "instance" ||
        canonical(current.instance.data.settings) !== canonical(step.executionSettings)
      )
        return yield* Effect.fail(new DomainError({ code: "delivery_unavailable" }));
    }
  });
