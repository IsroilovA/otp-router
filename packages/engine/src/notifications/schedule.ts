import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { enqueueNotification } from "../queue/jobs.js";
// Called inside the challenge transaction, alongside its persisted event and snapshot.
export const scheduleNotification = (eventId: string, time: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO otp_router.notifications(event_id,next_attempt_at) VALUES (${eventId},${time})`;
    yield* enqueueNotification(eventId, time);
  });
