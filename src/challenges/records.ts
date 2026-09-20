import { Schema } from "effect";
import { DeliveryState, VerificationState } from "./contracts.js";
import { Ciphertext, Digest } from "./crypto.js";
export const SavedProvider = Schema.Struct({
  providerInstanceId: Schema.String,
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
  codeLength: Schema.Int,
  lifetimeSeconds: Schema.Int,
  maxIncorrectGuesses: Schema.Int,
  maxSends: Schema.Int,
  resendCooldownSeconds: Schema.Int,
  manualSelectionEnabled: Schema.Boolean,
  manualProviderIds: Schema.Array(Schema.String),
  requestedLocale: Schema.String,
  providers: Schema.Array(SavedProvider).pipe(Schema.check(Schema.isMinLength(1))),
});
export type PolicySnapshot = typeof PolicySnapshot.Type;
export const Challenge = Schema.Struct({
  id: Schema.String,
  purpose: Schema.String,
  context_id: Schema.String,
  recipient_token: Schema.String,
  policy_id: Schema.String,
  snapshot: PolicySnapshot,
  verification_state: VerificationState,
  verification_id: Schema.NullOr(Schema.String),
  verified_at: Schema.NullOr(Schema.Date),
  created_at: Schema.Date,
  expires_at: Schema.Date,
  terminal_at: Schema.NullOr(Schema.Date),
  incorrect_guesses: Schema.Int,
  send_count: Schema.Int,
  routing_revision: Schema.Int,
  automatic_stopped: Schema.Boolean,
  current_delivery_id: Schema.String,
  next_user_send_at: Schema.Date,
});
export type Challenge = typeof Challenge.Type;
export const Delivery = Schema.Struct({
  id: Schema.String,
  challenge_id: Schema.String,
  provider_instance_id: Schema.String,
  route_position: Schema.Int,
  routing_revision: Schema.Int,
  reason: Schema.Literals(["initial", "fallback", "resend", "next", "select"]),
  due_at: Schema.Date,
  state: DeliveryState,
  reserved_at: Schema.NullOr(Schema.Date),
  completed_at: Schema.NullOr(Schema.Date),
  acceptance: Schema.NullOr(Schema.Literals(["accepted", "not_accepted", "unknown"])),
  failure_category: Schema.NullOr(Schema.String),
  diagnostic_code: Schema.NullOr(Schema.String),
  provider_request_id: Schema.NullOr(Schema.String),
  retry_at: Schema.NullOr(Schema.Date),
});
export type Delivery = typeof Delivery.Type;
export const Secrets = Schema.Struct({
  challenge_id: Schema.String,
  phone: Ciphertext,
  code: Ciphertext,
  verifier: Digest,
});
