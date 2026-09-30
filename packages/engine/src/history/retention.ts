import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { rows } from "../database/query.js";
import { transaction } from "../database/transaction.js";

export const cleanupEvents = (time: Date, retentionDays: number) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const cutoff = new Date(time.getTime() - retentionDays * 86400000);
      const candidates = yield* rows(
        Schema.Struct({ id: Schema.String, project_id: Schema.String }),
        sql`
    SELECT e.id,e.project_id FROM otp_router.events e LEFT JOIN otp_router.notifications n ON n.event_id = e.id
    WHERE e.occurred_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM otp_router.delivery_operations o WHERE o.id = e.operation_id)
      AND (n.event_id IS NULL OR (n.state = 'delivered' AND n.delivered_at < ${cutoff}))
    ORDER BY e.project_id,e.stream_sequence LIMIT 1000`,
      );
      // This transaction never acquires domain locks after taking stream locks.
      for (const project of [...new Set(candidates.map((event) => event.project_id))].sort())
        yield* sql`SELECT project_id FROM otp_router.project_streams WHERE project_id = ${project} FOR UPDATE`;
      for (const event of candidates) {
        yield* sql`UPDATE otp_router.project_streams SET floor = GREATEST(floor,COALESCE((SELECT stream_sequence FROM otp_router.events WHERE id = ${event.id}),0)) WHERE project_id = ${event.project_id}`;
        yield* sql`DELETE FROM otp_router.events WHERE id = ${event.id}`;
      }
      return candidates;
    }),
  );
