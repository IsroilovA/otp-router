import { SqlClient } from "effect/unstable/sql";
import { rows } from "../database/query.js";
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
import { Delivery, type Challenge } from "./records.js";
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
    label: provider.label,
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
  };
};
export const buildSnapshot = (config: RuntimeConfiguration, challenge: Challenge, time: Date) =>
  Effect.gen(function* () {
    const delivery = yield* findDelivery(challenge.current_delivery_id);
    const stopped = yield* invalidRecipient(challenge.id);
    const actions = deliveryActions(challenge, delivery, {
      options: yield* availableProviders(config, challenge, time),
      time,
      stopped,
    });
    const common = activeAction(challenge);
    const guessRetry = yield* quotaRetryAt(
      [recipientLimit(challenge.recipient_token, "guess", config.settings.recipientGuessLimit15m)],
      time,
    );
    const verify =
      common.allowed && guessRetry !== undefined ? deny("rate_limited", guessRetry) : common;
    const sql = yield* SqlClient.SqlClient;
    const evidence = yield* rows(
      Delivery,
      sql`SELECT * FROM otp_router.deliveries WHERE challenge_id = ${challenge.id} AND state IN ('accepted','delivered','uncertain') ORDER BY reserved_at DESC NULLS LAST,id`,
    );
    const accepted = evidence.find(
      (entry) => entry.state === "accepted" || entry.state === "delivered",
    );
    const provider =
      accepted === undefined ? undefined : challenge.snapshot.providers[accepted.route_position];
    return {
      challengeId: challenge.id,
      revision: challenge.public_revision + 1,
      ...overallState(
        challenge,
        { ...delivery, failure_category: stopped ? "InvalidRecipient" : delivery.failure_category },
        accepted !== undefined,
        evidence.some((entry) => entry.state === "uncertain"),
      ),
      channel: provider?.channel ?? null,
      provider:
        provider === undefined ? null : { id: provider.providerInstanceId, label: provider.label },
      expiresAt: challenge.expires_at.toISOString(),
      serverTime: time.toISOString(),
      actions: {
        ...actions,
        verify,
        cancel: challenge.verification_state === "cancelled" ? { allowed: true } : common,
      },
    } satisfies Snapshot;
  });
// Acceptance survives another delivery's failure or uncertainty. Only confirmed final
// failure of that accepted delivery invalidates its evidence.
export const overallState = (
  challenge: Pick<Challenge, "verification_state" | "processing_started">,
  delivery: Pick<Delivery, "state" | "diagnostic_code" | "failure_category">,
  accepted: boolean,
  uncertain: boolean,
): Pick<Snapshot, "state" | "reason"> => {
  switch (challenge.verification_state) {
    case "verified":
      return { state: "verified", reason: null };
    case "expired":
    case "cancelled":
    case "locked":
      return { state: "failed", reason: challenge.verification_state };
    case "active":
      break;
  }
  if (delivery.state === "pending" || delivery.state === "dispatching")
    return { state: challenge.processing_started ? "sending" : "queued", reason: null };
  if (accepted) return { state: "accepted", reason: null };
  if (uncertain) return { state: "uncertain", reason: "delivery_uncertain" };
  const reason =
    delivery.failure_category === "InvalidRecipient"
      ? "invalid_recipient"
      : delivery.diagnostic_code === "rate_limited"
        ? "rate_limited"
        : delivery.diagnostic_code === "provider_unavailable"
          ? "provider_unavailable"
          : "delivery_failed";
  return { state: "failed", reason };
};
