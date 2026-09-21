import { Webhook } from "standardwebhooks";
import { SqlClient } from "effect/unstable/sql";
import { Data, Effect, Schema } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { rows } from "../database/query.js";
import { databaseTime, transaction } from "../database/transaction.js";
import { enqueueNotification } from "../queue/jobs.js";

const attemptLimit = 12;
export class NotificationTransportError extends Data.TaggedError(
  "NotificationTransportError",
)<{}> {}
const Claimed = Schema.Struct({ body: Schema.String, attempts: Schema.Int });
export const signingHeaders = (secret: string, eventId: string, body: string, time: Date) => ({
  "content-type": "application/json",
  "webhook-id": eventId,
  "webhook-timestamp": String(Math.floor(time.getTime() / 1000)),
  "webhook-signature": new Webhook(secret).sign(eventId, time, body),
});
const claim = (id: string) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return (yield* rows(
        Claimed,
        sql`
    WITH claimed AS (
      UPDATE otp_router.notifications SET state = 'delivering', attempts = attempts + 1,
        lease_until = clock_timestamp() + interval '30 seconds'
      WHERE event_id = ${id} AND attempts < ${attemptLimit}
        AND ((state = 'pending' AND next_attempt_at <= clock_timestamp())
          OR (state = 'delivering' AND lease_until <= clock_timestamp()))
      RETURNING event_id,attempts
    ) SELECT e.body,c.attempts FROM claimed c JOIN otp_router.events e ON e.id = c.event_id
  `,
      ))[0];
    }),
  );
const finish = (id: string, attempt: number, status: number | undefined) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const time = yield* databaseTime;
      const succeeded = status !== undefined && status >= 200 && status < 300;
      const state = succeeded ? "delivered" : attempt >= attemptLimit ? "failed" : "pending";
      const next = new Date(time.getTime() + Math.min(3600, 5 * 2 ** (attempt - 1)) * 1000);
      const updated = yield* rows(
        Schema.Struct({ event_id: Schema.String }),
        sql`
    UPDATE otp_router.notifications SET state = ${state}, next_attempt_at = ${next}, lease_until = NULL,
      delivered_at = ${succeeded ? time : null}, last_status = ${status ?? null},
      last_failure = ${succeeded ? null : status === undefined ? "transport_error" : "http_error"}
    WHERE event_id = ${id} AND state = 'delivering' AND attempts = ${attempt} RETURNING event_id
  `,
      );
      if (state === "pending" && updated.length !== 0) yield* enqueueNotification(id, next);
    }),
  );
export const notifyEvent = (config: RuntimeConfiguration, id: string) =>
  Effect.gen(function* () {
    const destination = config.settings.webhook;
    if (destination === undefined) return;
    const claimed = yield* claim(id);
    if (claimed === undefined) return;
    // No transaction spans network work. Retries use the stored bytes and event ID;
    // each network attempt signs with a fresh timestamp. Redirects are not followed.
    const status = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(destination.url, {
          method: "POST",
          redirect: "manual",
          signal,
          headers: signingHeaders(destination.signingSecret, id, claimed.body, new Date()),
          body: claimed.body,
        });
        await response.body?.cancel();
        return response.status;
      },
      catch: () => new NotificationTransportError(),
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTag(["NotificationTransportError", "TimeoutError"], () =>
        Effect.succeed(undefined),
      ),
    );
    yield* finish(id, claimed.attempts, status);
  });
// Recovery also repairs a missing/expired queue job. Claims prevent duplicate jobs
// from producing concurrent sends; an interrupted HTTP attempt can be redelivered.
export const recoverNotifications = transaction(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE otp_router.notifications SET state = 'failed', lease_until = NULL, last_failure = 'worker_recovery' WHERE state = 'delivering' AND lease_until <= clock_timestamp() AND attempts >= ${attemptLimit}`;
    const due = yield* rows(
      Schema.Struct({ event_id: Schema.String }),
      sql`SELECT event_id FROM otp_router.notifications WHERE (state = 'pending' AND next_attempt_at <= clock_timestamp()) OR (state = 'delivering' AND lease_until <= clock_timestamp()) ORDER BY next_attempt_at LIMIT 1000`,
    );
    for (const row of due) yield* enqueueNotification(row.event_id, yield* databaseTime);
  }),
);
export const replayNotification = (id: string) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const found = yield* rows(
        Schema.Struct({ event_id: Schema.String }),
        sql`UPDATE otp_router.notifications SET state = 'pending', attempts = 0, lease_until = NULL, next_attempt_at = clock_timestamp() WHERE event_id = ${id} AND state = 'failed' RETURNING event_id`,
      );
      if (found.length !== 0) yield* enqueueNotification(id, yield* databaseTime);
      return found.length !== 0;
    }),
  );
