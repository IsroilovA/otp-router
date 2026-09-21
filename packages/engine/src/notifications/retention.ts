import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { rows } from "../database/query.js";
export const cleanupNotifications = (time: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Delivered notifications/events retain seven days; failed and outstanding
    // notifications survive challenge cleanup until an operator replays them.
    const events = yield* rows(
      Schema.Struct({ deleted: Schema.Int }),
      sql`DELETE FROM otp_router.events WHERE id IN (SELECT e.id FROM otp_router.events e LEFT JOIN otp_router.notifications n ON n.event_id = e.id WHERE e.occurred_at < ${new Date(time.getTime() - 7 * 86400000)} AND (n.event_id IS NULL OR (n.state = 'delivered' AND n.delivered_at < ${new Date(time.getTime() - 7 * 86400000)})) LIMIT 1000) RETURNING 1 AS deleted`,
    );

    return events;
  });
