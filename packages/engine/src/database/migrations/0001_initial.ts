import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE SCHEMA otp_router`;
  yield* sql`CREATE TABLE otp_router.delivery_operations (
    id uuid PRIMARY KEY, project_id text NOT NULL, creation_sequence bigint, owner text NOT NULL CHECK (owner IN ('external','challenge')),
    purpose text NOT NULL, context_id text NOT NULL, recipient_token text NOT NULL,
    policy_id text NOT NULL,
    authorization_required boolean NOT NULL,
    max_sends integer NOT NULL CHECK (max_sends BETWEEN 1 AND 10),
    resend_cooldown_seconds integer NOT NULL CHECK (resend_cooldown_seconds >= 0),
    manual_selection_enabled boolean NOT NULL,
    state text NOT NULL CHECK (state IN ('prepared','active','closed','expired')),
    created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, terminal_at timestamptz, history_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    public_revision integer NOT NULL DEFAULT 0 CHECK (public_revision >= 0), public_snapshot jsonb,
    processing_started boolean NOT NULL DEFAULT false,
    routing_revision integer NOT NULL DEFAULT 1 CHECK (routing_revision > 0),
    automatic_stopped boolean NOT NULL DEFAULT false, recipient_invalid boolean NOT NULL DEFAULT false, current_attempt_id uuid,
    initial_position integer NOT NULL CHECK (initial_position >= 0), next_user_send_at timestamptz NOT NULL,
    CHECK ((state IN ('prepared','active')) = (terminal_at IS NULL)),
    CHECK (expires_at > created_at)
  )`;
  yield* sql`CREATE UNIQUE INDEX operations_creation ON otp_router.delivery_operations(project_id,creation_sequence)`;
  yield* sql`CREATE INDEX operations_expiry ON otp_router.delivery_operations(expires_at) WHERE state IN ('prepared','active')`;
  yield* sql`CREATE INDEX operations_retention ON otp_router.delivery_operations(GREATEST(terminal_at,history_updated_at)) WHERE terminal_at IS NOT NULL`;
  yield* sql`CREATE TABLE otp_router.operation_route_steps (
    operation_id uuid NOT NULL REFERENCES otp_router.delivery_operations(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position >= 0),
    provider_instance_id text NOT NULL, label text NOT NULL, plugin_id text NOT NULL,
    contract_version integer NOT NULL CHECK (contract_version = 1), channel text NOT NULL,
    resolved_locale text NOT NULL, template jsonb NOT NULL,
    send_timeout_ms bigint NOT NULL CHECK (send_timeout_ms BETWEEN 1 AND 9007199254740991),
    min_delivery_window_ms bigint NOT NULL CHECK (min_delivery_window_ms BETWEEN 0 AND 9007199254740991),
    compatibility_revision text NOT NULL, manual_selection_allowed boolean NOT NULL,
    PRIMARY KEY (operation_id,position), UNIQUE (operation_id,provider_instance_id)
  )`;
  yield* sql`ALTER TABLE otp_router.delivery_operations ADD CONSTRAINT initial_route_step
    FOREIGN KEY (id,initial_position) REFERENCES otp_router.operation_route_steps(operation_id,position)
    DEFERRABLE INITIALLY DEFERRED`;
  yield* sql`CREATE TABLE otp_router.delivery_secrets (
    operation_id uuid PRIMARY KEY REFERENCES otp_router.delivery_operations(id) ON DELETE CASCADE,
    phone jsonb NOT NULL, code jsonb, code_fingerprint jsonb,
    CHECK ((code IS NULL) = (code_fingerprint IS NULL))
  )`;
  yield* sql`CREATE TABLE otp_router.challenges (
    id uuid PRIMARY KEY, operation_id uuid NOT NULL UNIQUE REFERENCES otp_router.delivery_operations(id) ON DELETE CASCADE,
    code_length integer NOT NULL CHECK (code_length BETWEEN 6 AND 8),
    max_incorrect_guesses integer NOT NULL CHECK (max_incorrect_guesses BETWEEN 1 AND 5),
    verification_state text NOT NULL CHECK (verification_state IN ('active','verified','locked','expired','cancelled')),
    verification_id uuid UNIQUE,
    incorrect_guesses integer NOT NULL DEFAULT 0 CHECK (incorrect_guesses BETWEEN 0 AND max_incorrect_guesses),
    public_revision integer NOT NULL DEFAULT 0 CHECK (public_revision >= 0), public_snapshot jsonb,
    CHECK ((verification_state = 'verified') = (verification_id IS NOT NULL))
  )`;
  yield* sql`CREATE TABLE otp_router.challenge_secrets (
    challenge_id uuid PRIMARY KEY REFERENCES otp_router.challenges(id) ON DELETE CASCADE, verifier jsonb NOT NULL
  )`;
  yield* sql`CREATE TABLE otp_router.delivery_attempts (
    id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES otp_router.delivery_operations(id) ON DELETE CASCADE,
    route_position integer NOT NULL CHECK (route_position >= 0),
    routing_revision integer NOT NULL CHECK (routing_revision > 0),
    reason text NOT NULL CHECK (reason IN ('initial','fallback','resend','next','select')),
    revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0), public_snapshot jsonb, creation_sequence bigint,
    created_at timestamptz NOT NULL,
    state text NOT NULL CHECK (state IN ('pending','dispatching','accepted','delivered','failed','uncertain','suppressed')),
    acceptance text CHECK (acceptance IN ('accepted','not_accepted','unknown')),
    failure_category text, diagnostic_code text,
    authorization_state text NOT NULL CHECK (authorization_state IN ('not_required','pending','approved','denied','expired')),
    authorization_generation integer NOT NULL DEFAULT 0 CHECK (authorization_generation >= 0),
    project_generation integer NOT NULL DEFAULT 0 CHECK (project_generation >= 0),
    authorization_retry_at timestamptz, authorization_lease_until timestamptz,
    approved_at timestamptz, approval_expires_at timestamptz,
    invocation text NOT NULL DEFAULT 'not_started' CHECK (invocation IN ('not_started','committed','not_invoked')),
    committed_at timestamptz, recovery_at timestamptz,
    CHECK ((authorization_state = 'approved') = (approved_at IS NOT NULL)),
    CHECK ((authorization_state = 'approved') = (approval_expires_at IS NOT NULL)),
    CHECK (authorization_lease_until IS NULL OR authorization_state = 'pending'),
    CHECK ((committed_at IS NULL) = (recovery_at IS NULL)),
    CHECK (invocation <> 'committed' OR committed_at IS NOT NULL),
    CHECK (invocation <> 'not_started' OR committed_at IS NULL),
    CHECK (recovery_at > committed_at),
    CHECK (state <> 'dispatching' OR (invocation = 'committed' AND committed_at IS NOT NULL)),
    UNIQUE (operation_id,id),
    FOREIGN KEY (operation_id,route_position) REFERENCES otp_router.operation_route_steps(operation_id,position),
    CHECK (state NOT IN ('accepted','delivered') OR acceptance IS NOT DISTINCT FROM 'accepted')
  )`;
  yield* sql`ALTER TABLE otp_router.delivery_operations ADD CONSTRAINT current_operation_attempt
    FOREIGN KEY (id,current_attempt_id) REFERENCES otp_router.delivery_attempts(operation_id,id)
    DEFERRABLE INITIALLY DEFERRED`;
  // Saved route identity is immutable; evidence may only update an existing attempt.
  yield* sql`CREATE FUNCTION otp_router.reject_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Saved routing identity is immutable' USING ERRCODE = '23514'; END
  $$`;
  yield* sql`CREATE TRIGGER immutable_route_step BEFORE UPDATE ON otp_router.operation_route_steps
    FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION otp_router.reject_identity_change()`;
  yield* sql`CREATE TRIGGER immutable_attempt_route BEFORE UPDATE ON otp_router.delivery_attempts
    FOR EACH ROW WHEN ((OLD.id,OLD.operation_id,OLD.route_position,OLD.routing_revision,OLD.reason,OLD.created_at)
      IS DISTINCT FROM (NEW.id,NEW.operation_id,NEW.route_position,NEW.routing_revision,NEW.reason,NEW.created_at))
    EXECUTE FUNCTION otp_router.reject_identity_change()`;
  yield* sql`CREATE UNIQUE INDEX attempts_advancement ON otp_router.delivery_attempts(operation_id,routing_revision,route_position) WHERE reason = 'fallback'`;
  yield* sql`CREATE UNIQUE INDEX attempts_creation ON otp_router.delivery_attempts(operation_id,creation_sequence)`;
  yield* sql`CREATE INDEX attempts_recovery ON otp_router.delivery_attempts(recovery_at) WHERE state = 'dispatching'`;
  yield* sql`CREATE INDEX attempts_pending ON otp_router.delivery_attempts(created_at) WHERE state = 'pending'`;
  // Events and receipts retain historical attribution after domain history is removed.
  yield* sql`CREATE TABLE otp_router.events (
    id uuid PRIMARY KEY, subject_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('challenge.updated','delivery.updated','attempt.updated','attempt.evidence')), revision integer NOT NULL CHECK (revision > 0),
    project_id text NOT NULL, operation_id uuid NOT NULL, stream_sequence bigint,
    transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(), ordinal bigserial NOT NULL,
    occurred_at timestamptz NOT NULL, body text NOT NULL,
    UNIQUE(kind,subject_id,revision)
  )`;
  yield* sql`CREATE TABLE otp_router.project_streams(project_id text PRIMARY KEY, head bigint NOT NULL DEFAULT 0, floor bigint NOT NULL DEFAULT 0, CHECK (floor >= 0 AND floor <= head))`;
  yield* sql`CREATE TABLE otp_router.project_send_blocks(project_id text PRIMARY KEY, blocked_until timestamptz NOT NULL, generation integer NOT NULL DEFAULT 1 CHECK (generation > 0))`;
  yield* sql`CREATE UNIQUE INDEX events_stream ON otp_router.events(project_id,stream_sequence)`;
  yield* sql`CREATE INDEX events_operation ON otp_router.events(project_id,operation_id,stream_sequence)`;
  yield* sql`CREATE INDEX events_subject ON otp_router.events(project_id,subject_id,stream_sequence)`;
  yield* sql`CREATE INDEX events_transaction ON otp_router.events(transaction_id) WHERE stream_sequence IS NULL`;
  yield* sql`CREATE INDEX events_retention ON otp_router.events(occurred_at)`;
  yield* sql`CREATE TABLE otp_router.notifications (
    event_id uuid PRIMARY KEY REFERENCES otp_router.events(id) ON DELETE CASCADE,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivering','delivered','failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL, lease_until timestamptz,
    last_status integer, last_failure text CHECK (last_failure IN ('http_error','transport_error','worker_recovery')),
    delivered_at timestamptz,
    CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
    CHECK ((state = 'delivering') = (lease_until IS NOT NULL))
  )`;
  yield* sql`CREATE INDEX notifications_due ON otp_router.notifications(next_attempt_at) WHERE state IN ('pending','delivering')`;
  yield* sql`CREATE TABLE otp_router.provider_correlations (
    provider_instance_id text NOT NULL, reference text NOT NULL,
    attempt_id uuid NOT NULL REFERENCES otp_router.delivery_attempts(id) ON DELETE CASCADE,
    PRIMARY KEY (provider_instance_id, reference)
  )`;
  // Provider identity is retained in the correlation lookup key, but must agree
  // with the immutable saved route. Attempts and route steps cannot be reassigned.
  yield* sql`CREATE FUNCTION otp_router.check_correlation_provider() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM otp_router.delivery_attempts a
        JOIN otp_router.operation_route_steps r ON (r.operation_id,r.position) = (a.operation_id,a.route_position)
        WHERE a.id = NEW.attempt_id AND r.provider_instance_id = NEW.provider_instance_id
      ) THEN RAISE EXCEPTION 'Correlation provider does not match attempt route' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END
  $$`;
  yield* sql`CREATE TRIGGER correlation_provider BEFORE INSERT OR UPDATE ON otp_router.provider_correlations
    FOR EACH ROW EXECUTE FUNCTION otp_router.check_correlation_provider()`;
  yield* sql`CREATE INDEX correlations_attempt ON otp_router.provider_correlations(attempt_id)`;
  yield* sql`CREATE TABLE otp_router.callback_inbox (
    provider_instance_id text NOT NULL, deduplication_key text NOT NULL, reference text NOT NULL,
    status text NOT NULL CHECK (status IN ('accepted','delivered','failed')),
    received_at timestamptz NOT NULL, event_at text, diagnostic_code text, processed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (provider_instance_id,deduplication_key)
  )`;
  yield* sql`CREATE INDEX inbox_unmatched ON otp_router.callback_inbox(provider_instance_id,reference) WHERE processed = false`;
  // No operation foreign key: a retained receipt must replay after history cleanup.
  yield* sql`CREATE TABLE otp_router.request_receipts (
    identity text PRIMARY KEY, capability text NOT NULL CHECK (capability IN ('managed','external')),
    project_id text NOT NULL, operation_id uuid NOT NULL,
    fingerprint jsonb NOT NULL, code_fingerprint jsonb, response jsonb NOT NULL,
    created_at timestamptz NOT NULL, retain_until timestamptz NOT NULL,
    CHECK (retain_until > created_at)
  )`;
  yield* sql`CREATE INDEX receipts_operation ON otp_router.request_receipts(operation_id)`;
  yield* sql`CREATE INDEX receipts_retention ON otp_router.request_receipts(retain_until)`;
  // Quota facts have their own lifetime. They deliberately do not reference domain history.
  yield* sql`CREATE TABLE otp_router.quota_events (
    event_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('create','send','guess','admission')),
    occurred_at timestamptz NOT NULL, PRIMARY KEY (event_id,kind)
  )`;
  yield* sql`CREATE TABLE otp_router.quota_allocations (
    scope text NOT NULL CHECK (scope IN ('recipient','project','provider','deployment')),
    scope_id text NOT NULL, event_id uuid NOT NULL, kind text NOT NULL,
    PRIMARY KEY (scope,scope_id,kind,event_id),
    FOREIGN KEY (event_id,kind) REFERENCES otp_router.quota_events(event_id,kind) ON DELETE CASCADE,
    CHECK ((scope = 'deployment') = (scope_id = ''))
  )`;
  yield* sql`CREATE INDEX quota_window ON otp_router.quota_events(kind,occurred_at,event_id)`;
  yield* sql`CREATE INDEX quota_retention ON otp_router.quota_events(occurred_at)`;
  yield* sql`CREATE INDEX quota_allocations_event ON otp_router.quota_allocations(event_id,kind)`;
  yield* sql`CREATE TABLE otp_router.provider_restrictions(provider_instance_id text PRIMARY KEY,retry_at timestamptz NOT NULL)`;
  yield* sql`CREATE TABLE otp_router.deployment_identity(singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),deployment_id text NOT NULL,recipient_key_fingerprint text NOT NULL)`;
});
