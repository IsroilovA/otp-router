import { Data, Schema } from "effect";

export const DeliveryJob = Schema.Struct({
  version: Schema.Literal(1),
  attemptId: Schema.String.check(Schema.isUUID()),
  routingRevision: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});
export type DeliveryJob = typeof DeliveryJob.Type;
export const NotificationJob = Schema.Struct({ eventId: Schema.String.check(Schema.isUUID()) });
export const ExpiryJob = Schema.Struct({ operationId: Schema.String.check(Schema.isUUID()) });

export const deliveryQueue = "otp-delivery-v1";
export const notificationQueue = "otp-notification-v1";
export const expiryQueue = "otp-expiry-v1";
export const cleanupQueue = "otp-cleanup-v1";
export type QueueName =
  | typeof deliveryQueue
  | typeof notificationQueue
  | typeof expiryQueue
  | typeof cleanupQueue;

export class QueueOperationError extends Data.TaggedError("QueueOperationError")<{}> {}
