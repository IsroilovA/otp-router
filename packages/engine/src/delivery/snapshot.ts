import { admissionLimit, quotaRetryAt } from "./quotas.js";
import { SqlClient } from "effect/unstable/sql";
import { rows } from "../database/query.js";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import {
  availableProviders,
  chooseAvailable,
  nextProvider,
  userSendBlock,
  withAdmissionCooldown,
  type ProviderAvailability,
} from "./eligibility.js";
import type { Snapshot } from "./contracts.js";
import { Attempt, type Operation } from "./records.js";
import { findAttempt, invalidRecipient } from "./store.js";

type Action = Snapshot["actions"]["resend"];
const deny = (reason: NonNullable<Action["reason"]>, availableAt?: string): Action => ({
  allowed: false,
  reason,
  ...(availableAt === undefined ? {} : { availableAt }),
});
const activeAction = (operation: Operation): Action =>
  operation.state === "active"
    ? { allowed: true }
    : deny(operation.state === "prepared" ? "code_required" : "operation_unavailable");
const sendAction = (operation: Operation, time: Date, retryAt: string | undefined): Action => {
  const active = activeAction(operation);
  if (!active.allowed) return active;
  const blocked = userSendBlock(operation, time, retryAt);
  return blocked === undefined ? { allowed: true } : deny(blocked.code, blocked.retryAt);
};
const deliveryActions = (
  operation: Operation,
  delivery: Attempt,
  availability: {
    readonly options: readonly ProviderAvailability[];
    readonly stopped: boolean;
    readonly time: Date;
  },
) => {
  const { options, stopped, time } = availability;
  const common = stopped ? deny("delivery_unavailable") : activeAction(operation);
  const manual = options.filter((option) =>
    operation.snapshot.manualProviderIds.includes(option.provider.providerInstanceId),
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
  ) => (option === undefined ? deny(missing) : sendAction(operation, time, option.retryAt));
  return {
    resend: common.allowed ? action(current, "provider_unavailable") : common,
    next: common.allowed ? action(next, "no_next_provider") : common,
    select: {
      ...(common.allowed
        ? operation.snapshot.manualSelectionEnabled
          ? action(selected, "provider_unavailable")
          : deny("manual_selection_disabled")
        : common),
      choices,
    },
  };
};
export const buildSnapshot = (config: RuntimeConfiguration, operation: Operation, time: Date) =>
  Effect.gen(function* () {
    const delivery =
      operation.current_attempt_id === null
        ? undefined
        : yield* findAttempt(operation.current_attempt_id);
    if (delivery === undefined) return preparedSnapshot(operation, time);
    const stopped = yield* invalidRecipient(operation.id);
    const admissionRetry = yield* quotaRetryAt([admissionLimit(operation.recipient_token)], time);
    const actions = deliveryActions(withAdmissionCooldown(operation, admissionRetry), delivery, {
      options: yield* availableProviders(config, operation, time),
      time,
      stopped,
    });
    const sql = yield* SqlClient.SqlClient;
    const evidence = yield* rows(
      Attempt,
      sql`SELECT * FROM otp_router.delivery_attempts WHERE operation_id = ${operation.id} AND state IN ('accepted','delivered','uncertain') ORDER BY reserved_at DESC NULLS LAST,id`,
    );
    const accepted = evidence.find(
      (entry) => entry.state === "accepted" || entry.state === "delivered",
    );
    const provider =
      accepted === undefined ? undefined : operation.snapshot.providers[accepted.route_position];
    return {
      operationId: operation.id,
      revision: operation.public_revision + 1,
      ...overallState(
        operation,
        { ...delivery, failure_category: stopped ? "InvalidRecipient" : delivery.failure_category },
        accepted !== undefined,
        evidence.some((entry) => entry.state === "uncertain"),
      ),
      channel: provider?.channel ?? null,
      provider:
        provider === undefined ? null : { id: provider.providerInstanceId, label: provider.label },
      expiresAt: operation.expires_at.toISOString(),
      serverTime: time.toISOString(),
      actions: {
        ...actions,
        submitCode:
          operation.state === "prepared" ? { allowed: true } : deny("operation_unavailable"),
        close: operation.state === "expired" ? deny("operation_unavailable") : { allowed: true },
      },
    } satisfies Snapshot;
  });
// Acceptance survives another delivery's failure or uncertainty. Only confirmed final
// failure of that accepted delivery invalidates its evidence.
export const overallState = (
  operation: Pick<Operation, "state" | "processing_started">,
  delivery: Pick<Attempt, "state" | "diagnostic_code" | "failure_category">,
  accepted: boolean,
  uncertain: boolean,
): Pick<Snapshot, "state" | "reason"> => {
  switch (operation.state) {
    case "prepared":
      return { state: "prepared", reason: null };
    case "closed":
      return { state: "closed", reason: null };
    case "expired":
      return { state: "expired", reason: null };
    case "active":
      break;
  }
  if (delivery.state === "pending" || delivery.state === "dispatching")
    return { state: operation.processing_started ? "sending" : "queued", reason: null };
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

const preparedSnapshot = (operation: Operation, time: Date) => {
  const unavailable = deny(
    operation.state === "prepared" ? "code_required" : "operation_unavailable",
  );
  return {
    operationId: operation.id,
    revision: operation.public_revision + 1,
    state:
      operation.state === "prepared"
        ? "prepared"
        : operation.state === "expired"
          ? "expired"
          : "closed",
    reason: null,
    channel: null,
    provider: null,
    expiresAt: operation.expires_at.toISOString(),
    serverTime: time.toISOString(),
    actions: {
      submitCode:
        operation.state === "prepared" ? { allowed: true } : deny("operation_unavailable"),
      close: { allowed: true },
      resend: unavailable,
      next: unavailable,
      select: { ...unavailable, choices: [] },
    },
  } satisfies Snapshot;
};
