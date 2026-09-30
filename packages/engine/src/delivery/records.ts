import { InstanceSettings, Policy } from "../runtime/contracts.js";
import { Schema } from "effect";
import { Ciphertext, Digest } from "../crypto.js";
import { Snapshot } from "./contracts.js";
import { IntegrationReference } from "./input.js";
const AttemptState = Schema.Literals([
  "pending",
  "dispatching",
  "accepted",
  "delivered",
  "failed",
  "uncertain",
  "suppressed",
]);
export const SavedProvider = Schema.Struct({
  providerInstanceId: Schema.String,
  label: Schema.String,
  pluginId: Schema.String,
  contractVersion: Schema.Literal(2),
  channel: Schema.String,
  resolvedLocale: Schema.String,
  template: Schema.Json,
  sendTimeoutMs: Schema.Number,
  minDeliveryWindowMs: Schema.Number,
  accountId: Schema.String,
  instanceRevision: Schema.Int,
  executionSettings: InstanceSettings,
  minCodeLength: Schema.Int,
  maxCodeLength: Schema.Int,
  grantId: Schema.String,
  accountEpoch: Schema.Int,
  instanceEpoch: Schema.Int,
  manualSelectionAllowed: Schema.Boolean,
});
export type SavedProvider = typeof SavedProvider.Type;
export const PolicySnapshot = Schema.Struct({
  policyId: Schema.String,
  policyRevision: Schema.Int,
  policyEpoch: Schema.Int,
  policyGrantId: Schema.String,
  policy: Policy,
  authorizationRequired: Schema.Boolean,
  maxSends: Schema.Int,
  resendCooldownSeconds: Schema.Int,
  manualSelectionEnabled: Schema.Boolean,
  providers: Schema.Array(SavedProvider).pipe(Schema.check(Schema.isMinLength(1))),
});
export type PolicySnapshot = typeof PolicySnapshot.Type;
export const Attempt = Schema.Struct({
  revision: Schema.Int,
  dispatch_deadline: Schema.Date,
  authorization_state: Schema.Literals([
    "not_required",
    "pending",
    "approved",
    "denied",
    "expired",
  ]),
  authorization_generation: Schema.Int,
  project_generation: Schema.Int,
  authorization_retry_at: Schema.NullOr(Schema.Date),
  authorization_lease_until: Schema.NullOr(Schema.Date),
  approved_at: Schema.NullOr(Schema.Date),
  approval_expires_at: Schema.NullOr(Schema.Date),
  invocation: Schema.Literals(["not_started", "committed", "not_invoked"]),
  id: Schema.String,
  operation_id: Schema.String,
  intent_id: Schema.String,
  provider_instance_id: Schema.String,
  route_position: Schema.Int,
  routing_revision: Schema.Int,
  reason: Schema.Literals(["initial", "fallback", "resend", "next", "select"]),
  created_at: Schema.Date,
  state: AttemptState,
  committed_at: Schema.NullOr(Schema.Date),
  recovery_at: Schema.NullOr(Schema.Date),
  acceptance: Schema.NullOr(Schema.Literals(["accepted", "not_accepted", "unknown"])),
  failure_category: Schema.NullOr(Schema.String),
  diagnostic_code: Schema.NullOr(Schema.String),
});
export type Attempt = typeof Attempt.Type;
export const Operation = Schema.Struct({
  project_id: Schema.String,
  integration_reference: Schema.NullOr(IntegrationReference),
  id: Schema.String,
  owner: Schema.Literals(["external", "challenge"]),
  purpose: Schema.String,
  context_id: Schema.String,
  recipient_token: Schema.String,
  policy_id: Schema.String,
  snapshot: PolicySnapshot,
  state: Schema.Literals(["prepared", "active", "closed", "expired"]),
  created_at: Schema.Date,
  expires_at: Schema.Date,
  terminal_at: Schema.NullOr(Schema.Date),
  history_updated_at: Schema.Date,
  send_count: Schema.Int,
  public_revision: Schema.Int,
  public_snapshot: Schema.NullOr(Snapshot),
  processing_started: Schema.Boolean,
  routing_revision: Schema.Int,
  automatic_stopped: Schema.Boolean,
  recipient_invalid: Schema.Boolean,
  current_attempt_id: Schema.NullOr(Schema.String),
  initial_position: Schema.Int,
  next_user_send_at: Schema.Date,
});
export type Operation = typeof Operation.Type;
export const Secrets = Schema.Struct({
  operation_id: Schema.String,
  phone: Ciphertext,
  code: Schema.NullOr(Ciphertext),
  code_fingerprint: Schema.NullOr(Digest),
});
