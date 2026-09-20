import { notifyChallenge, recoverNotifications } from "../delivery/notifications/send.js";
import { challengeStatus } from "../challenges/status.js";
import { notificationQueue, expiryQueue, NotificationJob, ExpiryJob } from "../queue/jobs.js";
import { Effect, Schema } from "effect";
import { RouterConfig } from "../config/config.js";
import { cleanup } from "../challenges/cleanup.js";
import { dispatch } from "../delivery/dispatch.js";
import { Queue } from "../queue/client.js";
import { cleanupQueue, DeliveryJob, deliveryQueue, QueueOperationError } from "../queue/jobs.js";

export const startWorkers = Effect.gen(function* () {
  const boss = yield* Queue,
    config = yield* RouterConfig;
  const runtime = yield* Effect.context<Effect.Services<ReturnType<typeof dispatch>>>();
  const controllers = new Set<AbortController>();
  const running = new Set<Promise<void>>();
  let healthy = false;
  const stopped = () => {
    healthy = false;
  };
  boss.on("stopped", stopped);
  const run = (
    effect: Effect.Effect<void, QueueOperationError, Effect.Services<ReturnType<typeof dispatch>>>,
  ) => {
    const controller = new AbortController();
    controllers.add(controller);
    const promise = Effect.runPromiseWith(runtime)(effect, { signal: controller.signal });
    running.add(promise);
    return promise.finally(() => {
      controllers.delete(controller);
      running.delete(promise);
    });
  };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      healthy = false;
      yield* Effect.tryPromise({
        try: async () => {
          await boss.offWork(deliveryQueue, { wait: false });
          await boss.offWork(cleanupQueue, { wait: false });
          await boss.offWork(notificationQueue, { wait: false });
          await boss.offWork(expiryQueue, { wait: false });
        },
        catch: () => new QueueOperationError(),
      }).pipe(Effect.orDie);
      yield* Effect.promise(() => Promise.allSettled(running)).pipe(
        Effect.timeout(config.settings.shutdownGraceMs),
        Effect.catchTag("TimeoutError", () =>
          Effect.sync(() => {
            for (const controller of controllers) controller.abort();
          }),
        ),
      );
      boss.off("stopped", stopped);
    }),
  );
  yield* Effect.tryPromise({
    try: () =>
      boss.work(
        deliveryQueue,
        {
          batchSize: 1,
          localConcurrency: config.settings.workerConcurrency,
          pollingIntervalSeconds: 0.5,
        },
        async (jobs) => {
          for (const job of jobs)
            await run(
              Schema.decodeUnknownEffect(DeliveryJob)(job.data, { onExcessProperty: "error" }).pipe(
                Effect.flatMap((payload) => dispatch(config, payload)),
                Effect.catchCause(() => Effect.fail(new QueueOperationError())),
              ),
            );
        },
      ),
    catch: () => new QueueOperationError(),
  });
  yield* Effect.tryPromise({
    try: () =>
      boss.work(cleanupQueue, { batchSize: 1, pollingIntervalSeconds: 1 }, () =>
        run(
          cleanup(config).pipe(
            Effect.andThen(recoverNotifications),
            Effect.catchCause(() => Effect.fail(new QueueOperationError())),
          ),
        ),
      ),
    catch: () => new QueueOperationError(),
  });
  yield* recoverNotifications;
  yield* Effect.tryPromise({
    try: () =>
      boss.work(
        notificationQueue,
        {
          batchSize: 1,
          localConcurrency: config.settings.workerConcurrency,
          pollingIntervalSeconds: 0.5,
        },
        async (jobs) => {
          for (const job of jobs)
            await run(
              Schema.decodeUnknownEffect(NotificationJob)(job.data).pipe(
                Effect.flatMap(({ eventId }) => notifyChallenge(config, eventId)),
                Effect.catchCause(() => Effect.fail(new QueueOperationError())),
              ),
            );
        },
      ),
    catch: () => new QueueOperationError(),
  });
  yield* Effect.tryPromise({
    try: () =>
      boss.work(expiryQueue, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async (jobs) => {
        for (const job of jobs)
          await run(
            Schema.decodeUnknownEffect(ExpiryJob)(job.data).pipe(
              Effect.flatMap(({ challengeId }) => challengeStatus(config, challengeId)),
              Effect.asVoid,
              Effect.catchCause(() => Effect.fail(new QueueOperationError())),
            ),
          );
      }),
    catch: () => new QueueOperationError(),
  });
  yield* Effect.tryPromise({
    try: () => boss.schedule(cleanupQueue, "* * * * *", { version: 1 }),
    catch: () => new QueueOperationError(),
  });
  healthy = true;
  return {
    isRunning: () => healthy,
    interrupt: () => {
      for (const controller of controllers) controller.abort();
    },
    stopClaims: Effect.tryPromise({
      try: async () => {
        healthy = false;
        await boss.offWork(deliveryQueue, { wait: false });
        await boss.offWork(cleanupQueue, { wait: false });
        await boss.offWork(notificationQueue, { wait: false });
        await boss.offWork(expiryQueue, { wait: false });
      },
      catch: () => new QueueOperationError(),
    }),
  };
});
