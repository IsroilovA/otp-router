import type { Snapshot as DeliverySnapshot } from "../delivery/contracts.js";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { buildSnapshot as buildDelivery } from "../delivery/snapshot.js";
import { quotaRetryAt, recipientLimit } from "../delivery/quotas.js";
import type { Snapshot } from "./contracts.js";
import type { Challenge } from "./records.js";
export const buildSnapshot = (config: RuntimeConfiguration, challenge: Challenge, time: Date) =>
  Effect.gen(function* () {
    const delivery = yield* buildDelivery(config, challenge.delivery, time);
    const active = challenge.verification_state === "active";
    const deny = {
      allowed: false,
      reason:
        challenge.verification_state === "verified"
          ? ("already_verified" as const)
          : ("challenge_unavailable" as const),
    };
    const retry = yield* quotaRetryAt(
      [
        recipientLimit(
          challenge.delivery.recipient_token,
          "guess",
          config.settings.recipientGuessLimit15m,
        ),
      ],
      time,
    );
    const { submitCode: _submit, close: _close, ...sendActions } = delivery.actions;
    const translate = (action: typeof delivery.actions.resend): Snapshot["actions"]["resend"] =>
      action.reason === "operation_unavailable" || action.reason === "code_required"
        ? deny
        : {
            allowed: action.allowed,
            ...(action.reason === undefined ? {} : { reason: action.reason }),
            ...(action.availableAt === undefined ? {} : { availableAt: action.availableAt }),
          };
    return {
      challengeId: challenge.id,
      operationId: challenge.operation_id,
      revision: challenge.public_revision + 1,
      ...publicState(challenge, delivery),
      channel: delivery.channel,
      provider: delivery.provider,
      expiresAt: delivery.expiresAt,
      serverTime: time.toISOString(),
      actions: {
        verify: !active
          ? deny
          : retry === undefined
            ? { allowed: true }
            : { allowed: false, reason: "rate_limited", availableAt: retry },
        cancel: challenge.verification_state === "cancelled" || active ? { allowed: true } : deny,
        resend: active ? translate(sendActions.resend) : deny,
        next: active ? translate(sendActions.next) : deny,
        select: {
          ...(active ? translate(sendActions.select) : deny),
          choices: sendActions.select.choices,
        },
      },
    } satisfies Snapshot;
  });

const publicState = (
  challenge: Challenge,
  delivery: DeliverySnapshot,
): Pick<Snapshot, "state" | "reason"> => {
  switch (challenge.verification_state) {
    case "verified":
      return { state: "verified", reason: null };
    case "locked":
    case "expired":
    case "cancelled":
      return { state: "failed", reason: challenge.verification_state };
    case "active":
      return {
        state:
          delivery.state === "prepared"
            ? "queued"
            : delivery.state === "closed" || delivery.state === "expired"
              ? "failed"
              : delivery.state,
        reason: delivery.reason,
      };
  }
};
