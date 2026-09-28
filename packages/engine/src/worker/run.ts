import { recoverAuthorizations } from "../delivery/authorization.js";
import { Effect, Schema } from "effect";
import { RouterConfig } from "../config/runtime.js";
import { dispatch } from "../delivery/dispatch.js";
import { recoverDispatches } from "../delivery/recovery.js";
import { deliveryStatus } from "../delivery/service.js";
import { cleanup } from "../maintenance.js";
import { notifyEvent, recoverNotifications } from "../notifications/send.js";
import { Queue } from "../queue/client.js";
import {
  cleanupQueue,
  DeliveryJob,
  deliveryQueue,
  ExpiryJob,
  expiryQueue,
  NotificationJob,
  notificationQueue,
} from "../queue/contracts.js";
import { observeJob } from "./diagnostics.js";

export const WorkerSettings = Schema.Struct({
  concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  shutdownGraceMs: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 120000 })),
});
export const startWorkers = (options: typeof WorkerSettings.Type) =>
  Effect.gen(function* () {
    const settings = yield* Schema.decodeUnknownEffect(WorkerSettings)(options);
    const queue = yield* Queue;
    const config = yield* RouterConfig;
    const consumers = yield* queue.openConsumers(settings.shutdownGraceMs);
    yield* consumers.register(
      { queue: deliveryQueue, concurrency: settings.concurrency, pollingIntervalSeconds: 0.5 },
      (job) =>
        Schema.decodeUnknownEffect(DeliveryJob)(job.data, { onExcessProperty: "error" }).pipe(
          Effect.flatMap((payload) => dispatch(config, payload)),
          (effect) => observeJob(effect, { queue: deliveryQueue, jobId: job.id }),
        ),
    );
    yield* consumers.register(
      { queue: cleanupQueue, concurrency: 1, pollingIntervalSeconds: 1 },
      (job) =>
        observeJob(cleanup(config).pipe(Effect.andThen(recoverNotifications)), {
          queue: cleanupQueue,
          jobId: job.id,
        }),
    );
    yield* recoverDispatches(config);
    yield* recoverAuthorizations(config);
    yield* recoverNotifications;
    yield* consumers.register(
      { queue: notificationQueue, concurrency: settings.concurrency, pollingIntervalSeconds: 0.5 },
      (job) =>
        Schema.decodeUnknownEffect(NotificationJob)(job.data).pipe(
          Effect.flatMap(({ eventId }) => notifyEvent(config, eventId)),
          (effect) => observeJob(effect, { queue: notificationQueue, jobId: job.id }),
        ),
    );
    yield* consumers.register(
      { queue: expiryQueue, concurrency: 1, pollingIntervalSeconds: 0.5 },
      (job) =>
        Schema.decodeUnknownEffect(ExpiryJob)(job.data).pipe(
          Effect.flatMap(({ operationId }) => deliveryStatus(config, operationId)),
          Effect.asVoid,
          (effect) => observeJob(effect, { queue: expiryQueue, jobId: job.id }),
        ),
    );
    yield* consumers.scheduleCleanup;
    yield* consumers.ready;
    return {
      isRunning: consumers.isRunning,
      interrupt: consumers.interrupt,
      stopClaims: consumers.stopClaims,
    };
  });
