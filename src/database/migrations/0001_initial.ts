import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE SCHEMA otp_router`;
  yield* sql`CREATE TABLE otp_router.challenges (
    id uuid PRIMARY KEY, purpose text NOT NULL, context_id text NOT NULL,
    recipient_token text NOT NULL, policy_id text NOT NULL, snapshot jsonb NOT NULL,
    verification_state text NOT NULL CHECK (verification_state IN ('active','verified','locked','expired','cancelled')),
    verification_id uuid UNIQUE, verified_at timestamptz, created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL, terminal_at timestamptz,
    incorrect_guesses integer NOT NULL DEFAULT 0 CHECK (incorrect_guesses >= 0),
    send_count integer NOT NULL DEFAULT 0 CHECK (send_count >= 0),
    routing_revision integer NOT NULL DEFAULT 1 CHECK (routing_revision > 0),
    automatic_stopped boolean NOT NULL DEFAULT false, current_delivery_id uuid NOT NULL,
    next_user_send_at timestamptz NOT NULL,
    CHECK ((verification_state = 'verified') = (verification_id IS NOT NULL AND verified_at IS NOT NULL)),
    CHECK ((verification_state = 'active') = (terminal_at IS NULL))
  )`;
  yield* sql`CREATE INDEX challenges_expiry ON otp_router.challenges(expires_at) WHERE verification_state = 'active'`;
  yield* sql`CREATE INDEX challenges_terminal ON otp_router.challenges(terminal_at) WHERE terminal_at IS NOT NULL`;
  yield* sql`CREATE TABLE otp_router.challenge_secrets (
    challenge_id uuid PRIMARY KEY REFERENCES otp_router.challenges(id) ON DELETE CASCADE,
    phone jsonb NOT NULL, code jsonb NOT NULL, verifier jsonb NOT NULL
  )`;
  yield* sql`CREATE TABLE otp_router.deliveries (
    id uuid PRIMARY KEY, challenge_id uuid NOT NULL REFERENCES otp_router.challenges(id) ON DELETE CASCADE,
    provider_instance_id text NOT NULL, route_position integer NOT NULL CHECK (route_position >= 0),
    routing_revision integer NOT NULL CHECK (routing_revision > 0),
    reason text NOT NULL CHECK (reason IN ('initial','fallback','resend','next','select')),
    due_at timestamptz NOT NULL, state text NOT NULL CHECK (state IN ('pending','dispatching','accepted','delivered','failed','uncertain','suppressed')),
    reserved_at timestamptz, completed_at timestamptz, acceptance text CHECK (acceptance IN ('accepted','not_accepted','unknown')),
    failure_category text, diagnostic_code text, provider_request_id text, retry_at timestamptz,
    CHECK ((state = 'dispatching') IS NOT TRUE OR reserved_at IS NOT NULL)
  )`;
  yield* sql`CREATE UNIQUE INDEX deliveries_advancement ON otp_router.deliveries(challenge_id,routing_revision,route_position) WHERE reason = 'fallback'`;
  yield* sql`CREATE INDEX deliveries_challenge ON otp_router.deliveries(challenge_id)`;
  yield* sql`CREATE INDEX deliveries_pending ON otp_router.deliveries(due_at) WHERE state = 'pending'`;
  yield* sql`CREATE TABLE otp_router.provider_correlations (
    provider_instance_id text NOT NULL, reference text NOT NULL,
    delivery_id uuid NOT NULL REFERENCES otp_router.deliveries(id) ON DELETE CASCADE,
    PRIMARY KEY (provider_instance_id, reference)
  )`;
  yield* sql`CREATE TABLE otp_router.callback_inbox (
    provider_instance_id text NOT NULL, deduplication_key text NOT NULL, reference text NOT NULL,
    status text NOT NULL CHECK (status IN ('accepted','delivered','failed')),
    received_at timestamptz NOT NULL, event_at text, diagnostic_code text, processed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (provider_instance_id,deduplication_key)
  )`;
  yield* sql`CREATE INDEX inbox_unmatched ON otp_router.callback_inbox(provider_instance_id,reference) WHERE processed = false`;
  yield* sql`CREATE TABLE otp_router.idempotency_records (
    identity text PRIMARY KEY, fingerprint jsonb NOT NULL, code_fingerprint jsonb,
    challenge_id uuid NOT NULL, response jsonb NOT NULL, status integer NOT NULL,
    created_at timestamptz NOT NULL, retain_until timestamptz NOT NULL
  )`;
  yield* sql`CREATE INDEX idempotency_challenge ON otp_router.idempotency_records(challenge_id)`;
  yield* sql`CREATE TABLE otp_router.quota_keys (identity text PRIMARY KEY)`;
  yield* sql`CREATE TABLE otp_router.quota_events (
    identity text NOT NULL REFERENCES otp_router.quota_keys(identity), kind text NOT NULL,
    event_id uuid NOT NULL, occurred_at timestamptz NOT NULL,
    PRIMARY KEY (identity,kind,event_id)
  )`;
  yield* sql`CREATE INDEX quota_window ON otp_router.quota_events(identity,kind,occurred_at)`;
});
