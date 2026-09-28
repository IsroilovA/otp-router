import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ChallengeEvent } from "../challenges/contracts.js";
import type { DeliveryEvent } from "../delivery/contracts.js";
import { rows } from "../database/query.js";
import { scheduleNotification } from "./schedule.js";

export const persistEvent = (
  event: Omit<ChallengeEvent, "sequence"> | Omit<DeliveryEvent, "sequence">,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const subject =
      event.type === "challenge.updated"
        ? {
            id: event.challenge.challengeId,
            operationId: event.challenge.operationId,
            revision: event.challenge.revision,
          }
        : {
            id: event.delivery.operationId,
            operationId: event.delivery.operationId,
            revision: event.delivery.revision,
          };
    yield* sql`INSERT INTO otp_router.events(id,project_id,operation_id,subject_id,kind,revision,occurred_at,body) VALUES (${event.eventId},${event.projectId},${subject.operationId},${subject.id},${event.type},${subject.revision},${new Date(event.occurredAt)},${JSON.stringify(event)})`;
  });

// Last domain transaction step: after all subject locks/writes, acquire stream
// heads in project order. No operation lock may be acquired after this point.
// Counter updates roll back with the events, preventing out-of-order commit gaps.
export const finalizeEvents = (notify: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pending = yield* rows(
      Schema.Struct({ id: Schema.String, project_id: Schema.String, occurred_at: Schema.Date }),
      sql`SELECT id,project_id,occurred_at FROM otp_router.events WHERE transaction_id = pg_current_xact_id() AND stream_sequence IS NULL ORDER BY project_id,ordinal`,
    );
    for (const event of pending) {
      const counters = yield* rows(
        Schema.Struct({ head: Schema.String }),
        sql`INSERT INTO otp_router.project_streams(project_id,head) VALUES (${event.project_id},1) ON CONFLICT (project_id) DO UPDATE SET head = project_streams.head + 1 RETURNING head::text`,
      );
      const sequence = counters[0]?.head;
      if (sequence === undefined) return yield* Effect.die(new Error("Missing project stream"));
      yield* sql`UPDATE otp_router.events SET stream_sequence = ${sequence}::bigint, body = (body::jsonb || jsonb_build_object('sequence',${sequence}::text))::text WHERE id = ${event.id}`;
      if (notify) yield* scheduleNotification(event.id, event.occurred_at);
    }
  });
