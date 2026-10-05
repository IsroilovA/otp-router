import { lockProject } from "../projects/store.js";
import { SqlClient } from "effect/unstable/sql";
import { Effect, Schema } from "effect";
import { rows, single } from "../database/query.js";
import { DomainError } from "../errors.js";
import { Operation, Attempt } from "./records.js";
import { AttemptSnapshot } from "./history-contracts.js";

const readOperation = (id: string, lock: boolean, project?: { readonly id: string }) =>
  Effect.gen(function* () {
    if (!Schema.is(Schema.String.check(Schema.isUUID()))(id))
      return yield* Effect.fail(new DomainError({ code: "operation_not_found" }));
    const sql = yield* SqlClient.SqlClient;
    const owned = project === undefined ? sql`` : sql`AND o.project_id = ${project.id}`;
    // Acquire the parent lock before reading dependent facts; a waiter must observe
    // the dispatches committed by the previous lock holder.
    if (lock) {
      const owners = yield* rows(
        Schema.Struct({ project_id: Schema.String }),
        sql`SELECT project_id FROM otp_router.delivery_operations o WHERE id = ${id} ${owned}`,
      );
      if (owners[0] !== undefined) yield* lockProject(owners[0].project_id);
    }
    if (lock)
      yield* sql`SELECT id FROM otp_router.delivery_operations o WHERE id = ${id} ${owned} FOR UPDATE`;
    const values = yield* rows(
      Operation,
      sql`
      SELECT o.id,o.project_id,o.integration_reference,o.owner,o.purpose,o.context_id,o.recipient_token,o.policy_id,
        o.state,o.created_at,o.expires_at,o.terminal_at,o.history_updated_at,o.public_revision,o.public_snapshot,
        o.processing_started,o.routing_revision,o.automatic_stopped,o.recipient_invalid,o.current_attempt_id,
        o.initial_position,o.next_user_send_at,
        (SELECT count(*)::int FROM otp_router.delivery_attempts a
          WHERE a.operation_id = o.id AND a.committed_at IS NOT NULL) AS send_count,
        s.snapshot
      FROM otp_router.delivery_operations o JOIN otp_router.operation_snapshots s ON s.id = o.id WHERE o.id = ${id} ${owned}`,
    );
    const operation = values[0];
    if (operation === undefined)
      return yield* Effect.fail(new DomainError({ code: "operation_not_found" }));
    return operation;
  });
export const findOperation = (id: string, lock = false) => readOperation(id, lock);
export const findProjectOperation = (projectId: string, id: string, lock = false) =>
  readOperation(id, lock, { id: projectId });

export const PublishedAttempt = Schema.Struct({
  ...Attempt.fields,
  public_snapshot: Schema.NullOr(AttemptSnapshot),
  project_id: Schema.String,
  integration_reference: Operation.fields.integration_reference,
  channel: Schema.String,
});
export const findAttempt = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* single(
      PublishedAttempt,
      sql`
    SELECT a.*,r.provider_instance_id,r.channel,o.project_id,o.integration_reference,
      o.expires_at - (r.send_timeout_ms + r.min_delivery_window_ms) * interval '1 millisecond' AS dispatch_deadline
    FROM otp_router.delivery_attempts a
    JOIN otp_router.operation_route_steps r ON (r.operation_id,r.position) = (a.operation_id,a.route_position)
    JOIN otp_router.delivery_operations o ON o.id = a.operation_id
    WHERE a.id = ${id}`,
    );
  });
