import { Schema } from "effect";
import { Identifier, IntegrationReference } from "./input.js";

export const AttemptSnapshot = Schema.Struct({
  attemptId: Schema.String,
  operationId: Schema.String,
  projectId: Identifier,
  integrationReference: Schema.optionalKey(IntegrationReference),
  revision: Schema.Int,
  routingRevision: Schema.Int,
  providerInstanceId: Identifier,
  channel: Identifier,
  reason: Schema.Literals(["initial", "fallback", "resend", "next", "select"]),
  createdAt: Schema.String,
  dispatchDeadline: Schema.String,
  dispatchCommittedAt: Schema.NullOr(Schema.String),
  observedAt: Schema.String,
  state: Schema.Literals([
    "pending",
    "dispatching",
    "accepted",
    "delivered",
    "failed",
    "uncertain",
    "suppressed",
  ]),
  acceptance: Schema.NullOr(Schema.Literals(["accepted", "not_accepted", "unknown"])),
  failureCategory: Schema.NullOr(Schema.String),
  diagnosticCode: Schema.NullOr(Schema.String),
  invocation: Schema.Literals(["not_started", "committed", "not_invoked"]),
  authorization: Schema.Struct({
    state: Schema.Literals(["not_required", "pending", "approved", "denied", "expired"]),
    approvedAt: Schema.NullOr(Schema.String),
    validUntil: Schema.NullOr(Schema.String),
  }),
});
const envelope = {
  eventId: Schema.String,
  projectId: Identifier,
  sequence: Schema.String,
  occurredAt: Schema.String,
};
export const AttemptEvent = Schema.Struct({
  ...envelope,
  type: Schema.Literal("attempt.updated"),
  attempt: AttemptSnapshot,
});
export const EvidenceEvent = Schema.Struct({
  ...envelope,
  type: Schema.Literal("attempt.evidence"),
  operationId: Schema.String,
  integrationReference: Schema.optionalKey(IntegrationReference),
  attemptId: Schema.String,
  evidence: Schema.Struct({
    state: Schema.Literals(["accepted", "delivered", "failed", "uncertain"]),
    acceptance: Schema.Literals(["accepted", "not_accepted", "unknown"]),
    diagnosticCode: Schema.NullOr(Schema.String),
    providerEventTime: Schema.NullOr(Schema.String),
  }),
});
