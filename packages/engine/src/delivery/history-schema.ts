import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

// Installed only by the initial schema. The journal belongs to delivery; triggers
// also cover suppression/recovery bulk updates without losing intermediate facts.
export const installAttemptHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE FUNCTION otp_router.attempt_history() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE parent otp_router.delivery_operations; provider jsonb; event_id uuid; observed timestamptz; body jsonb;
  BEGIN
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'retry_at' - 'recovery_at') =
      (to_jsonb(OLD) - 'retry_at' - 'recovery_at') THEN RETURN NEW; END IF;
    NEW.revision := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE OLD.revision + 1 END;
    observed := clock_timestamp();
    SELECT * INTO STRICT parent FROM otp_router.delivery_operations WHERE id = NEW.operation_id;
    provider := parent.snapshot->'providers'->NEW.route_position;
    event_id := gen_random_uuid();
    body := jsonb_build_object(
      'eventId',event_id,'type','attempt.updated','projectId',parent.project_id,'occurredAt',observed,
      'attempt',jsonb_build_object(
        'attemptId',NEW.id,'operationId',NEW.operation_id,'projectId',parent.project_id,
        'revision',NEW.revision,'routingRevision',NEW.routing_revision,
        'providerInstanceId',NEW.provider_instance_id,'channel',provider->>'channel','reason',NEW.reason,
        'createdAt',NEW.due_at,'dispatchDeadline',NEW.dispatch_deadline,
        'dispatchCommittedAt',NEW.reserved_at,'observedAt',observed,'state',NEW.state,
        'acceptance',NEW.acceptance,'failureCategory',NEW.failure_category,'diagnosticCode',NEW.diagnostic_code,
        'invocation',NEW.invocation,'authorization',jsonb_build_object(
          'state',NEW.authorization_state,'approvedAt',NEW.approved_at,'validUntil',NEW.approval_expires_at)));
    NEW.public_snapshot := body->'attempt';
    INSERT INTO otp_router.events(id,project_id,subject_id,operation_id,kind,revision,occurred_at,body)
      VALUES(event_id,parent.project_id,NEW.id,NEW.operation_id,'attempt.updated',NEW.revision,observed,body::text);
    UPDATE otp_router.delivery_operations SET history_updated_at = observed WHERE id = NEW.operation_id;
    RETURN NEW;
  END $$`;
  yield* sql`CREATE TRIGGER attempt_history BEFORE INSERT OR UPDATE ON otp_router.delivery_attempts
    FOR EACH ROW EXECUTE FUNCTION otp_router.attempt_history()`;
});
