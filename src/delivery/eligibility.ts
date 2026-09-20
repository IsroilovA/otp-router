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
        time.getTime() + provider.minDeliveryWindowMs + provider.sendTimeoutMs <
          challenge.expires_at.getTime() &&
        !restricted.some((row) => row.provider_instance_id === provider.providerInstanceId),
    );
  });
export const resolveChoice = (
  snapshot: {
    readonly manualSelectionEnabled: boolean;
    readonly manualProviderIds: readonly string[];
    readonly providers: readonly SavedProvider[];
  },
  choice: Choice,
  eligible: readonly SavedProvider[],
) => {
  if (!snapshot.manualSelectionEnabled)
    return Effect.fail(new DomainError({ code: "delivery_option_not_allowed" }));
  const provider = eligible.find(
    (item) =>
      snapshot.manualProviderIds.includes(item.providerInstanceId) &&
      (choice.type === "channel"
        ? item.channel === choice.channel
        : item.providerInstanceId === choice.providerInstanceId),
  );
  return provider === undefined
    ? Effect.fail(new DomainError({ code: "delivery_option_not_allowed" }))
    : Effect.succeed(provider);
};
