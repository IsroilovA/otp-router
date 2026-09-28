import type { ProviderRejected } from "../providers/contract.js";
import type { Attempt, Operation } from "./records.js";

export interface Outcome {
  readonly state: "accepted" | "delivered" | "failed" | "uncertain";
  readonly acceptance: "accepted" | "not_accepted" | "unknown";
  readonly failureCategory?: ProviderRejected["reason"];
  readonly diagnosticCode?: string;
  readonly retryAt?: Date;
  readonly stop?: boolean;
  readonly notInvoked?: boolean;
  readonly providerEventTime?: string;
}

type AttemptEvidence = Pick<
  Attempt,
  "state" | "acceptance" | "failure_category" | "diagnostic_code"
>;
type RoutingState = Pick<
  Operation,
  "state" | "automatic_stopped" | "recipient_invalid" | "current_attempt_id" | "routing_revision"
>;

const resultingState = (
  current: Attempt["state"],
  incoming: Outcome["state"],
): Attempt["state"] => {
  if (current === "delivered" || current === "suppressed") return current;
  if (current === "failed" && incoming !== "delivered") return current;
  if (current === "accepted" && incoming === "uncertain") return current;
  return incoming;
};

const mergeEvidence = (attempt: AttemptEvidence, outcome: Outcome): AttemptEvidence => {
  const repeatedFailure = attempt.state === "failed" && outcome.state === "failed";
  return {
    state: outcome.state,
    acceptance:
      outcome.state === "delivered" || attempt.acceptance === "accepted"
        ? "accepted"
        : outcome.acceptance,
    failure_category: repeatedFailure
      ? (attempt.failure_category ?? outcome.failureCategory ?? null)
      : (outcome.failureCategory ?? null),
    diagnostic_code: repeatedFailure
      ? (attempt.diagnostic_code ?? outcome.diagnosticCode ?? null)
      : (outcome.diagnosticCode ?? null),
  };
};

const evidenceChanged = (previous: AttemptEvidence, next: AttemptEvidence): boolean =>
  previous.state !== next.state ||
  previous.acceptance !== next.acceptance ||
  previous.failure_category !== next.failure_category ||
  previous.diagnostic_code !== next.diagnostic_code;

const mayAdvance = (
  operation: RoutingState,
  attempt: Pick<Attempt, "id" | "routing_revision">,
  recipientInvalid: boolean,
): boolean =>
  operation.state === "active" &&
  !operation.automatic_stopped &&
  !recipientInvalid &&
  operation.current_attempt_id === attempt.id &&
  operation.routing_revision === attempt.routing_revision;

// Evidence describes one existing invocation. Only a new explicit command may
// create user work; weaker or duplicate evidence must not repeat that command.
export const decideOutcome = (
  operation: RoutingState,
  attempt: AttemptEvidence & Pick<Attempt, "id" | "routing_revision">,
  outcome: Outcome,
) => {
  const state = resultingState(attempt.state, outcome.state);
  const applies = state === outcome.state;
  const evidence = applies ? mergeEvidence(attempt, outcome) : attempt;
  const recipientInvalid = operation.recipient_invalid || (applies && outcome.stop === true);
  const newAcceptance = applies && state === "accepted" && attempt.state !== "accepted";
  const newDelivery = applies && state === "delivered" && attempt.state !== "delivered";
  return {
    evidence,
    applies,
    recipientInvalid,
    stopAutomatic: recipientInvalid || newDelivery,
    suppressPending:
      applies && outcome.stop === true
        ? ("all" as const)
        : newAcceptance || newDelivery
          ? ("fallback" as const)
          : ("none" as const),
    advance:
      applies &&
      state === "failed" &&
      attempt.state !== "failed" &&
      mayAdvance(operation, attempt, recipientInvalid),
    changed:
      applies &&
      (evidenceChanged(attempt, evidence) ||
        recipientInvalid !== operation.recipient_invalid ||
        outcome.retryAt !== undefined),
  };
};
