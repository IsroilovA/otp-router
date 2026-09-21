import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE SCHEMA otp_router`;
  yield* sql`CREATE TABLE otp_router.delivery_operations (
    id uuid PRIMARY KEY, owner text NOT NULL CHECK (owner IN ('external','challenge')),
    purpose text NOT NULL, context_id text NOT NULL, recipient_token text NOT NULL,
    policy_id text NOT NULL, snapshot jsonb NOT NULL,
    state text NOT NULL CHECK (state IN ('prepared','active','closed','expired')),
    created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, terminal_at timestamptz,
    send_count integer NOT NULL DEFAULT 0 CHECK (send_count >= 0),
    public_revision integer NOT NULL DEFAULT 0 CHECK (public_revision >= 0), public_snapshot jsonb,
    processing_started boolean NOT NULL DEFAULT false,
    routing_revision integer NOT NULL DEFAULT 1 CHECK (routing_revision > 0),
    automatic_stopped boolean NOT NULL DEFAULT false, current_attempt_id uuid,
    initial_position integer NOT NULL CHECK (initial_position >= 0), next_user_send_at timestamptz NOT NULL,
    CHECK ((state IN ('prepared','active')) = (terminal_at IS NULL)),
    CHECK (expires_at > created_at)
  )`;
  yield* sql`CREATE INDEX operations_expiry ON otp_router.delivery_operations(expires_at) WHERE state IN ('prepared','active')`;
  yield* sql`CREATE INDEX operations_terminal ON otp_router.delivery_operations(terminal_at) WHERE terminal_at IS NOT NULL`;
  yield* sql`CREATE TABLE otp_router.delivery_secrets (
    operation_id uuid PRIMARY KEY REFERENCES otp_router.delivery_operations(id) ON DELETE CASCADE,
    phone jsonb NOT NULL, code jsonb, code_fingerprint jsonb,
    CHECK ((code IS NULL) = (code_fingerprint IS NULL))
  )`;
  yield* sql`CREATE TABLE otp_router.challenges (
    id uuid PRIMARY KEY, operation_id uuid NOT NULL UNIQUE REFERENCES otp_router.delivery_operations(id) ON DELETE CASCADE,
    purpose text NOT NULL, context_id text NOT NULL, code_length integer NOT NULL CHECK (code_length BETWEEN 6 AND 8),
    max_incorrect_guesses integer NOT NULL CHECK (max_incorrect_guesses BETWEEN 1 AND 5),
    verification_state text NOT NULL CHECK (verification_state IN ('active','verified','locked','expired','cancelled')),
    verification_id uuid UNIQUE, verified_at timestamptz, created_at timestamptz NOT NULL, terminal_at timestamptz,
    incorrect_guesses integer NOT NULL DEFAULT 0 CHECK (incorrect_guesses >= 0),
    public_revision integer NOT NULL DEFAULT 0 CHECK (public_revision >= 0), public_snapshot jsonb,
    CHECK ((verification_state = 'verified') = (verification_id IS NOT NULL AND verified_at IS NOT NULL)),
    CHECK ((verification_state = 'active') = (terminal_at IS NULL))
  )`;
  yield* sql`CREATE TABLE otp_router.challenge_secrets (
    challenge_id uuid PRIMARY KEY REFERENCES otp_router.challenges(id) ON DELETE CASCADE, verifier jsonb NOT NULL
  )`;
  yield* sql`CREATE TABLE otp_router.delivery_attempts (
    id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES otp_router.delivery_operations(id) ON DELETE CASCADE,
    provider_instance_id text NOT NULL, route_position integer NOT NULL CHECK (route_position >= 0),
    routing_revision integer NOT NULL CHECK (routing_revision > 0),
    reason text NOT NULL CHECK (reason IN ('initial','fallback','resend','next','select')),
    due_at timestamptz NOT NULL, state text NOT NULL CHECK (state IN ('pending','dispatching','accepted','delivered','failed','uncertain','suppressed')),
    reserved_at timestamptz, completed_at timestamptz, acceptance text CHECK (acceptance IN ('accepted','not_accepted','unknown')),
    failure_category text, diagnostic_code text, provider_request_id text, retry_at timestamptz,
    CHECK ((state = 'dispatching') IS NOT TRUE OR reserved_at IS NOT NULL)
  )`;
  yield* sql`CREATE UNIQUE INDEX attempts_advancement ON otp_router.delivery_attempts(operation_id,routing_revision,route_position) WHERE reason = 'fallback'`;
  yield* sql`CREATE INDEX attempts_operation ON otp_router.delivery_attempts(operation_id)`;
  yield* sql`CREATE INDEX attempts_pending ON otp_router.delivery_attempts(due_at) WHERE state = 'pending'`;
  yield* sql`CREATE TABLE otp_router.events (
    id uuid PRIMARY KEY, subject_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('challenge.updated','delivery.updated')), revision integer NOT NULL CHECK (revision > 0),
    occurred_at timestamptz NOT NULL, body text NOT NULL,
    UNIQUE(kind,subject_id,revision)
  )`;
  yield* sql`CREATE INDEX events_retention ON otp_router.events(occurred_at)`;
  yield* sql`CREATE TABLE otp_router.notifications (
    event_id uuid PRIMARY KEY REFERENCES otp_router.events(id) ON DELETE CASCADE,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivering','delivered','failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL, lease_until timestamptz,
    last_status integer, last_failure text CHECK (last_failure IN ('http_error','transport_error','worker_recovery')),
    delivered_at timestamptz
  )`;
  yield* sql`CREATE INDEX notifications_due ON otp_router.notifications(next_attempt_at) WHERE state IN ('pending','delivering')`;
  yield* sql`CREATE TABLE otp_router.provider_correlations (
    provider_instance_id text NOT NULL, reference text NOT NULL,
    attempt_id uuid NOT NULL REFERENCES otp_router.delivery_attempts(id) ON DELETE CASCADE,
    PRIMARY KEY (provider_instance_id, reference)
  )`;
  yield* sql`CREATE INDEX correlations_attempt ON otp_router.provider_correlations(attempt_id)`;
  yield* sql`CREATE TABLE otp_router.callback_inbox (
    provider_instance_id text NOT NULL, deduplication_key text NOT NULL, reference text NOT NULL,
    status text NOT NULL CHECK (status IN ('accepted','delivered','failed')),
    received_at timestamptz NOT NULL, event_at text, diagnostic_code text, processed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (provider_instance_id,deduplication_key)
  )`;
  yield* sql`CREATE INDEX inbox_unmatched ON otp_router.callback_inbox(provider_instance_id,reference) WHERE processed = false`;
  yield* sql`CREATE TABLE otp_router.idempotency_records (
    identity text PRIMARY KEY, fingerprint jsonb NOT NULL, code_fingerprint jsonb,
    challenge_id uuid NOT NULL, response jsonb NOT NULL, outcome text NOT NULL CHECK (outcome IN ('created','completed','delivery_queued','incorrect_code')),
    created_at timestamptz NOT NULL, retain_until timestamptz NOT NULL
  )`;
  yield* sql`CREATE INDEX idempotency_challenge ON otp_router.idempotency_records(challenge_id)`;
  yield* sql`CREATE TABLE otp_router.delivery_idempotency (
    identity text PRIMARY KEY, fingerprint jsonb NOT NULL, code_fingerprint jsonb,
    operation_id uuid NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL, retain_until timestamptz NOT NULL
  )`;
  yield* sql`CREATE INDEX delivery_idempotency_operation ON otp_router.delivery_idempotency(operation_id)`;
  yield* sql`CREATE TABLE otp_router.quota_events (
    identity text NOT NULL, kind text NOT NULL,
    event_id uuid NOT NULL, occurred_at timestamptz NOT NULL,
    PRIMARY KEY (identity,kind,event_id)
  )`;
  yield* sql`CREATE INDEX quota_window ON otp_router.quota_events(identity,kind,occurred_at)`;
  yield* sql`CREATE TABLE otp_router.provider_restrictions(provider_instance_id text PRIMARY KEY,retry_at timestamptz NOT NULL)`;
  yield* sql`CREATE TABLE otp_router.deployment_identity(singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),deployment_id text NOT NULL,recipient_key_fingerprint text NOT NULL)`;
});
