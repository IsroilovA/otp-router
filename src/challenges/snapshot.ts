import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { eligibleProviders } from "../delivery/eligibility.js";
import type { Snapshot } from "./contracts.js";
import type { Challenge, Delivery, SavedProvider } from "./records.js";
import { findDelivery, invalidRecipient } from "./store.js";
import { quotaRetryAt, recipientLimit, sendLimits } from "./quotas.js";

type Action = Snapshot["actions"]["resend"];
const deny = (reason: NonNullable<Action["reason"]>, availableAt?: string): Action => ({
  allowed: false,
  reason,
  ...(availableAt === undefined ? {} : { availableAt }),
});
const activeAction = (challenge: Challenge): Action =>
  challenge.verification_state === "active"
    ? { allowed: true }
    : deny(
        challenge.verification_state === "verified" ? "already_verified" : "challenge_unavailable",
      );
const sendAction = (challenge: Challenge, time: Date, retryAt: string | undefined): Action => {
  const active = activeAction(challenge);
  if (!active.allowed) return active;
  if (challenge.send_count >= challenge.snapshot.maxSends) return deny("rate_limited");
  const cooldown =
    time < challenge.next_user_send_at ? challenge.next_user_send_at.toISOString() : undefined;
  if (retryAt !== undefined)
    return deny("rate_limited", cooldown !== undefined && cooldown > retryAt ? cooldown : retryAt);
  if (cooldown !== undefined) return deny("cooldown_active", cooldown);
  return { allowed: true };
};
interface Option {
  readonly provider: SavedProvider;
  readonly action: Action;
}
const optionsFor = (config: RuntimeConfiguration, challenge: Challenge, time: Date) =>
  Effect.gen(function* () {
    const eligible = yield* eligibleProviders(config, challenge, time);
    return yield* Effect.forEach(eligible, (provider) =>
      Effect.gen(function* () {
        const retryAt = yield* quotaRetryAt(
          sendLimits(config.settings, challenge.recipient_token, provider.providerInstanceId),
          time,
        );
        return { provider, action: sendAction(challenge, time, retryAt) };
      }),
    );
  });
const selectAction = (challenge: Challenge, options: readonly Option[]): Action => {
  if (!challenge.snapshot.manualSelectionEnabled) return deny("manual_selection_disabled");
  if (options.length === 0) return deny("provider_unavailable");
  if (options.some((option) => option.action.allowed)) return { allowed: true };
  const future = options
    .flatMap((option) =>
      option.action.availableAt === undefined ? [] : [option.action.availableAt],
    )
    .sort()[0];
  return deny(options[0]?.action.reason ?? "provider_unavailable", future);
};
const deliveryActions = (
  config: RuntimeConfiguration,
  challenge: Challenge,
  delivery: Delivery,
  availability: { readonly options: readonly Option[]; readonly stopped: boolean },
) => {
  const { options, stopped } = availability;
  const common = stopped ? deny("delivery_unavailable") : activeAction(challenge);
  const manual = options.filter((option) =>
    challenge.snapshot.manualProviderIds.includes(option.provider.providerInstanceId),
  );
  const choices = manual.map(({ provider }) => ({
    providerInstanceId: provider.providerInstanceId,
    channel: provider.channel,
    label: config.settings.providerLabels[provider.providerInstanceId] ?? provider.channel,
  }));
  const current = options.find(
    (option) => option.provider.providerInstanceId === delivery.provider_instance_id,
  );
  const next = options.find(
    (option) => challenge.snapshot.providers.indexOf(option.provider) > delivery.route_position,
  );
  return {
    resend: common.allowed ? (current?.action ?? deny("provider_unavailable")) : common,
    next: common.allowed ? (next?.action ?? deny("no_next_provider")) : common,
    select: { ...(common.allowed ? selectAction(challenge, manual) : common), choices },
    hasNext: next !== undefined,
  };
};
export const snapshot = (config: RuntimeConfiguration, challenge: Challenge, time: Date) =>
  Effect.gen(function* () {
    const delivery = yield* findDelivery(challenge.current_delivery_id);
    const { hasNext, ...actions } = deliveryActions(config, challenge, delivery, {
      options: yield* optionsFor(config, challenge, time),
      stopped: yield* invalidRecipient(challenge.id),
    });
    const common = activeAction(challenge);
    const guessRetry = yield* quotaRetryAt(
      [recipientLimit(challenge.recipient_token, "guess", config.settings.recipientGuessLimit15m)],
      time,
    );
    const verify =
      common.allowed && guessRetry !== undefined ? deny("rate_limited", guessRetry) : common;
    return {
      challengeId: challenge.id,
      purpose: challenge.purpose,
      contextId: challenge.context_id,
      createdAt: challenge.created_at.toISOString(),
      expiresAt: challenge.expires_at.toISOString(),
      serverTime: time.toISOString(),
      verificationState: challenge.verification_state,
      ...(challenge.verified_at === null
        ? {}
        : { verifiedAt: challenge.verified_at.toISOString() }),
      delivery: {
        deliveryId: delivery.id,
        channel: challenge.snapshot.providers[delivery.route_position]?.channel ?? "unavailable",
        state: delivery.state,
        routing: routingCondition(delivery.state, hasNext),
      },
      actions: {
        ...actions,
        verify,
        cancel: challenge.verification_state === "cancelled" ? { allowed: true } : common,
      },
    } satisfies Snapshot;
  });
const routingCondition = (
  state: Snapshot["delivery"]["state"],
  hasNext: boolean,
): Snapshot["delivery"]["routing"] => {
  if (state === "pending") return "pending";
  if (state === "failed" || state === "suppressed") return hasNext ? "blocked" : "exhausted";
  return "waiting";
};
