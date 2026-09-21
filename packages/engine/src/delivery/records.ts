import { Schema } from "effect";
import { Ciphertext, Digest } from "../crypto.js";
import { Snapshot } from "./contracts.js";
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
  contractVersion: Schema.Literal(1),
  channel: Schema.String,
  resolvedLocale: Schema.String,
  template: Schema.Json,
  sendTimeoutMs: Schema.Number,
  minDeliveryWindowMs: Schema.Number,
  settingsFingerprint: Schema.String,
});
export type SavedProvider = typeof SavedProvider.Type;
export const PolicySnapshot = Schema.Struct({
  version: Schema.Literal(1),
  policyId: Schema.String,
  maxSends: Schema.Int,
  resendCooldownSeconds: Schema.Int,
  manualSelectionEnabled: Schema.Boolean,
  manualProviderIds: Schema.Array(Schema.String),
  requestedLocale: Schema.String,
  providers: Schema.Array(SavedProvider).pipe(Schema.check(Schema.isMinLength(1))),
});
export type PolicySnapshot = typeof PolicySnapshot.Type;
export const Attempt = Schema.Struct({
  id: Schema.String,
  operation_id: Schema.String,
  provider_instance_id: Schema.String,
  route_position: Schema.Int,
  routing_revision: Schema.Int,
  reason: Schema.Literals(["initial", "fallback", "resend", "next", "select"]),
  due_at: Schema.Date,
  state: AttemptState,
  reserved_at: Schema.NullOr(Schema.Date),
  completed_at: Schema.NullOr(Schema.Date),
  acceptance: Schema.NullOr(Schema.Literals(["accepted", "not_accepted", "unknown"])),
  failure_category: Schema.NullOr(Schema.String),
  diagnostic_code: Schema.NullOr(Schema.String),
  provider_request_id: Schema.NullOr(Schema.String),
  retry_at: Schema.NullOr(Schema.Date),
});
export type Attempt = typeof Attempt.Type;
export const Operation = Schema.Struct({
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
  send_count: Schema.Int,
  public_revision: Schema.Int,
  public_snapshot: Schema.NullOr(Snapshot),
  processing_started: Schema.Boolean,
  routing_revision: Schema.Int,
  automatic_stopped: Schema.Boolean,
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
