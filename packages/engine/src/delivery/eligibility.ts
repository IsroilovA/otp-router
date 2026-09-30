import {
  activeGrant,
  instanceAuthority,
  intentRuntimeAuthority,
  resource,
  revisionValid,
} from "../runtime/store.js";
import { commonSendLimits, providerSendLimits, quotaBlocks } from "../delivery/quotas.js";
import { deliveryWindowFits } from "../providers/timing.js";
import { SqlClient } from "effect/unstable/sql";
import { Effect, Schema } from "effect";
import { rows } from "../database/query.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { type Choice } from "./input.js";
import { DomainError } from "../errors.js";
import type { Operation, SavedProvider } from "./records.js";

export interface ProviderAvailability {
  readonly provider: SavedProvider;
  readonly position: number;
  readonly retryAt: string | undefined;
}
export const availableProviders = (
  config: RuntimeConfiguration,
  operation: Pick<Operation, "snapshot" | "expires_at" | "recipient_token" | "project_id">,
  time: Date,
  intentId?: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const restrictions = yield* rows(
      Schema.Struct({ provider_instance_id: Schema.String, retry_at: Schema.Date }),
      sql`SELECT provider_instance_id,retry_at FROM otp_router.provider_restrictions WHERE retry_at > ${time}`,
    );
    const policy = yield* resource("policy", operation.snapshot.policyId);
    if (
      policy.state !== "enabled" ||
      (yield* activeGrant(operation.project_id, "policy", policy.id)) === undefined ||
      !(yield* revisionValid("policy", policy.id, operation.snapshot.policyRevision))
    )
      return [];
    const authority = intentId === undefined ? undefined : yield* intentRuntimeAuthority(intentId);
    const candidates = [];
    for (const [position, provider] of operation.snapshot.providers.entries()) {
      const savedAuthority = authority?.steps.find(
        (step) => step.instanceId === provider.providerInstanceId,
      );
      const current = yield* instanceAuthority(
        operation.project_id,
        provider.providerInstanceId,
        savedAuthority?.grantId,
      );
      if (
        current === undefined ||
        !(yield* revisionValid(
          "instance",
          provider.providerInstanceId,
          provider.instanceRevision,
        )) ||
        !deliveryWindowFits(provider, operation.expires_at.getTime() - time.getTime())
      )
        continue;
      if (
        intentId !== undefined &&
        authority?.steps.some(
          (step) =>
            step.instanceId === provider.providerInstanceId &&
            step.instanceEpoch === current.instance.epoch &&
            step.accountEpoch === current.account.epoch &&
            step.grantId === current.grantId,
        ) !== true
      )
        continue;
      const blocks = yield* quotaBlocks(
        [
          ...(yield* commonSendLimits(
            config.settings,
            operation.recipient_token,
            operation.project_id,
          )),
          ...(yield* providerSendLimits(provider.providerInstanceId)),
        ],
        time,
      );
      const restriction = restrictions.find(
        (row) => row.provider_instance_id === provider.providerInstanceId,
      );
      const retryAt = [
        ...blocks.map((block) => block.retry_at.toISOString()),
        restriction?.retry_at.toISOString(),
      ]
        .filter((value) => value !== undefined)
        .sort()
        .at(-1);
      candidates.push({ provider, position, retryAt });
    }
    return candidates;
  });

export const chooseAvailable = (available: readonly ProviderAvailability[]) =>
  available.find((option) => option.retryAt === undefined) ??
  available.toSorted((a, b) => (a.retryAt ?? "").localeCompare(b.retryAt ?? ""))[0];

export const nextProvider = (available: readonly ProviderAvailability[], position: number) =>
  chooseAvailable(available.filter((option) => option.position > position));

export const resolveChoice = (
  snapshot: Pick<Operation["snapshot"], "manualSelectionEnabled">,
  choice: Choice | undefined,
  available: readonly ProviderAvailability[],
) => {
  if (choice !== undefined && !snapshot.manualSelectionEnabled)
    return Effect.fail(new DomainError({ code: "delivery_option_not_allowed" }));
  const candidates =
    choice === undefined
      ? available
      : available.filter(
          ({ provider }) =>
            provider.manualSelectionAllowed &&
            (choice.type === "channel"
              ? provider.channel === choice.channel
              : provider.providerInstanceId === choice.providerInstanceId),
        );
  const selected = chooseAvailable(candidates);
  return selected === undefined
    ? Effect.fail(
        new DomainError({
          code: choice === undefined ? "delivery_unavailable" : "delivery_option_not_allowed",
        }),
      )
    : Effect.succeed(selected);
};

export const userSendBlock = (
  operation: Operation,
  time: Date,
  retryAt: string | undefined,
): { readonly code: "rate_limited" | "cooldown_active"; readonly retryAt?: string } | undefined => {
  if (operation.send_count >= operation.snapshot.maxSends) return { code: "rate_limited" };
  const cooldown =
    time < operation.next_user_send_at ? operation.next_user_send_at.toISOString() : undefined;
  if (retryAt !== undefined)
    return {
      code: "rate_limited",
      retryAt: cooldown !== undefined && cooldown > retryAt ? cooldown : retryAt,
    };
  return cooldown === undefined ? undefined : { code: "cooldown_active", retryAt: cooldown };
};

export const withAdmissionCooldown = (
  operation: Operation,
  retryAt: string | undefined,
): Operation =>
  retryAt === undefined
    ? operation
    : {
        ...operation,
        next_user_send_at: new Date(
          Math.max(operation.next_user_send_at.getTime(), Date.parse(retryAt)),
        ),
      };
