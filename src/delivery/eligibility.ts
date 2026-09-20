import { commonSendLimits, providerSendLimits, quotaRetryAt } from "../challenges/quotas.js";
import { deliveryWindowFits } from "../providers/timing.js";
import { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
import { rows } from "../database/query.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { DomainError, type Choice } from "../challenges/contracts.js";
import type { Challenge, SavedProvider } from "../challenges/records.js";

export const providerCompatible = (config: RuntimeConfiguration, saved: SavedProvider) => {
  const provider = config.providers.get(saved.providerInstanceId);
  return (
    provider !== undefined &&
    provider.enabled &&
    provider.settingsFingerprint === saved.settingsFingerprint &&
    provider.pluginId === saved.pluginId
  );
};
export const eligibleProviders = (
  config: RuntimeConfiguration,
  challenge: Pick<Challenge, "snapshot" | "expires_at">,
  time: Date,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const restricted = yield* rows(
      Schema.Struct({ provider_instance_id: Schema.String }),
      sql`SELECT provider_instance_id FROM otp_router.provider_restrictions WHERE retry_at > ${time}`,
    );
    return challenge.snapshot.providers.filter(
      (provider) =>
        providerCompatible(config, provider) &&
        deliveryWindowFits(provider, challenge.expires_at.getTime() - time.getTime()) &&
        !restricted.some((row) => row.provider_instance_id === provider.providerInstanceId),
    );
  });
export interface ProviderAvailability {
  readonly provider: SavedProvider;
  readonly retryAt: string | undefined;
}
export const availableProviders = (
  config: RuntimeConfiguration,
  challenge: Pick<Challenge, "snapshot" | "expires_at" | "recipient_token">,
  time: Date,
) =>
  Effect.gen(function* () {
    const eligible = yield* eligibleProviders(config, challenge, time);
    const commonRetry = yield* quotaRetryAt(
      commonSendLimits(config.settings, challenge.recipient_token),
      time,
    );
    return yield* Effect.forEach(eligible, (provider) =>
      Effect.gen(function* () {
        const providerRetry = yield* quotaRetryAt(
          providerSendLimits(config.settings, provider.providerInstanceId),
          time,
        );
        const retryAt = [commonRetry, providerRetry]
          .filter((value) => value !== undefined)
          .sort()
          .at(-1);
        return { provider, retryAt };
      }),
    );
  });

export const resolveChoice = (
  snapshot: Pick<Challenge["snapshot"], "manualSelectionEnabled" | "manualProviderIds">,
  choice: Choice | undefined,
  available: readonly ProviderAvailability[],
) => {
  if (choice !== undefined && !snapshot.manualSelectionEnabled)
    return Effect.fail(new DomainError({ code: "delivery_option_not_allowed" }));
  const candidates =
    choice === undefined
      ? available.slice(0, 1)
      : available.filter(
          ({ provider }) =>
            snapshot.manualProviderIds.includes(provider.providerInstanceId) &&
            (choice.type === "channel"
              ? provider.channel === choice.channel
              : provider.providerInstanceId === choice.providerInstanceId),
        );
  const selected = candidates.find((option) => option.retryAt === undefined) ?? candidates[0];
  return selected === undefined
    ? Effect.fail(
        new DomainError({
          code: choice === undefined ? "delivery_unavailable" : "delivery_option_not_allowed",
        }),
      )
    : Effect.succeed(selected);
};
