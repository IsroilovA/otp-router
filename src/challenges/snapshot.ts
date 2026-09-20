import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import {
  availableProviders,
  chooseAvailable,
  nextProvider,
  userSendBlock,
  type ProviderAvailability,
} from "../delivery/eligibility.js";
import type { Snapshot } from "./contracts.js";
import type { Challenge, Delivery } from "./records.js";
import { findDelivery, invalidRecipient } from "./store.js";
import { quotaRetryAt, recipientLimit } from "./quotas.js";

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
  const blocked = userSendBlock(challenge, time, retryAt);
  return blocked === undefined ? { allowed: true } : deny(blocked.code, blocked.retryAt);
};
const deliveryActions = (
  config: RuntimeConfiguration,
  challenge: Challenge,
  delivery: Delivery,
  availability: {
    readonly options: readonly ProviderAvailability[];
    readonly stopped: boolean;
    readonly time: Date;
  },
) => {
  const { options, stopped, time } = availability;
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
  const next = nextProvider(options, delivery.route_position);
  const selected = chooseAvailable(manual);
  const action = (
    option: ProviderAvailability | undefined,
    missing: NonNullable<Action["reason"]>,
  ) => (option === undefined ? deny(missing) : sendAction(challenge, time, option.retryAt));
  return {
    resend: common.allowed ? action(current, "provider_unavailable") : common,
    next: common.allowed ? action(next, "no_next_provider") : common,
    select: {
      ...(common.allowed
        ? challenge.snapshot.manualSelectionEnabled
          ? action(selected, "provider_unavailable")
          : deny("manual_selection_disabled")
        : common),
      choices,
    },
    hasNext: next !== undefined,
  };
};
export const snapshot = (config: RuntimeConfiguration, challenge: Challenge, time: Date) =>
  Effect.gen(function* () {
    const delivery = yield* findDelivery(challenge.current_delivery_id);
    const { hasNext, ...actions } = deliveryActions(config, challenge, delivery, {
      options: yield* availableProviders(config, challenge, time),
      time,
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
