import type { SendOptions } from "pg-boss";
import { SqlClient } from "effect/unstable/sql";
import { Data, Effect, Schema } from "effect";
import { Queue } from "./client.js";

export const DeliveryJob = Schema.Struct({
  version: Schema.Literal(1),
  attemptId: Schema.String.check(Schema.isUUID()),
  routingRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});
export type DeliveryJob = typeof DeliveryJob.Type;
export const deliveryQueue = "otp-delivery-v1";
export const notificationQueue = "otp-notification-v1";
export const expiryQueue = "otp-expiry-v1";
export const NotificationJob = Schema.Struct({ eventId: Schema.String.check(Schema.isUUID()) });
export const ExpiryJob = Schema.Struct({ operationId: Schema.String.check(Schema.isUUID()) });
export const cleanupQueue = "otp-cleanup-v1";
export class QueueOperationError extends Data.TaggedError("QueueOperationError")<{}> {}
const enqueue = (name: string, job: object, options: SendOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const boss = yield* Queue;
    // Capture the current transaction connection here; this adapter never escapes this call.
    const runtime = yield* Effect.context<never>();
    yield* Effect.tryPromise({
      try: () =>
        boss.send(name, job, {
          retryLimit: 20,
          retryDelay: 5,
          expireInSeconds: 90,
          deleteAfterSeconds: 86400,
          ...options,
          db: {
            executeSql: async (text, values) => ({
              rows: Array.from(
                await Effect.runPromiseWith(runtime)(
                  sql.unsafe<Record<string, unknown>>(text, values).withoutTransform,
                ),
              ),
            }),
          },
        }),
      catch: () => new QueueOperationError(),
    }).pipe(Effect.uninterruptible);
  });
export const enqueueDelivery = (job: DeliveryJob) => enqueue(deliveryQueue, job);
export const enqueueNotification = (eventId: string, time: Date) =>
  enqueue(notificationQueue, { eventId }, { startAfter: time, singletonKey: eventId });
export const enqueueExpiry = (operationId: string, time: Date) =>
  enqueue(expiryQueue, { operationId }, { startAfter: time, singletonKey: operationId });
export const initializeQueues = Effect.gen(function* () {
  const boss = yield* Queue;
  yield* Effect.tryPromise({
    try: () => boss.createQueue(deliveryQueue),
    catch: () => new QueueOperationError(),
  });
  for (const name of [notificationQueue, expiryQueue])
    yield* Effect.tryPromise({
      try: () => boss.createQueue(name, { policy: "short" }),
      catch: () => new QueueOperationError(),
    });
  yield* Effect.tryPromise({
    try: () => boss.createQueue(cleanupQueue),
    catch: () => new QueueOperationError(),
  });
});
