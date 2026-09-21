import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ChallengeEvent } from "../challenges/contracts.js";
import type { DeliveryEvent } from "../delivery/contracts.js";
import { scheduleNotification } from "./schedule.js";

export const persistEvent = (event: ChallengeEvent | DeliveryEvent, notify: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const subject =
      event.type === "challenge.updated"
        ? { id: event.challenge.challengeId, revision: event.challenge.revision }
        : { id: event.delivery.operationId, revision: event.delivery.revision };
    const time = new Date(event.occurredAt);
    yield* sql`INSERT INTO otp_router.events(id,subject_id,kind,revision,occurred_at,body) VALUES (${event.eventId},${subject.id},${event.type},${subject.revision},${time},${JSON.stringify(event)})`;
    if (notify) yield* scheduleNotification(event.eventId, time);
  });
