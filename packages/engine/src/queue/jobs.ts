import { Effect } from "effect";
import { Queue } from "./client.js";
import type { DeliveryJob } from "./contracts.js";

export const enqueueDelivery = (job: DeliveryJob) =>
  Effect.flatMap(Queue, (queue) => queue.enqueueDelivery(job));
export const enqueueNotification = (eventId: string, time: Date) =>
  Effect.flatMap(Queue, (queue) => queue.enqueueNotification(eventId, time));
export const enqueueExpiry = (operationId: string, time: Date) =>
  Effect.flatMap(Queue, (queue) => queue.enqueueExpiry(operationId, time));
export const initializeQueues = Effect.flatMap(Queue, (queue) => queue.initialize);
