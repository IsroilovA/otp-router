import { Effect, Runtime, Schema } from "effect";
import { RouterConfig } from "../config/config.js";
import { cleanup } from "../challenges/cleanup.js";
import { dispatch } from "../delivery/dispatch.js";
import { Queue } from "../queue/client.js";
import { cleanupQueue, DeliveryJob, deliveryQueue, QueueOperationError } from "../queue/jobs.js";

export const startWorkers = Effect.gen(function* () {
  const boss = yield* Queue,
    config = yield* RouterConfig;
  const runtime = yield* Effect.runtime<
    Effect.Effect.Context<ReturnType<typeof dispatch>> | Effect.Effect.Context<typeof cleanup>
  >();
  const controllers = new Set<AbortController>();
  const running = new Set<Promise<void>>();
  let healthy = false;
  const stopped = () => {
    healthy = false;
  };
  boss.on("stopped", stopped);
  const run = (
    effect: Effect.Effect<
      void,
      QueueOperationError,
      Effect.Effect.Context<ReturnType<typeof dispatch>> | Effect.Effect.Context<typeof cleanup>
    >,
  ) => {
    const controller = new AbortController();
    controllers.add(controller);
    const promise = Runtime.runPromise(runtime)(effect, { signal: controller.signal });
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
        },
        catch: () => new QueueOperationError(),
      }).pipe(Effect.orDie);
      yield* Effect.promise(() => Promise.allSettled(running)).pipe(
        Effect.timeout(config.settings.shutdownGraceMs),
        Effect.catchTag("TimeoutException", () =>
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
              Schema.decodeUnknown(DeliveryJob)(job.data, { onExcessProperty: "error" }).pipe(
                Effect.flatMap((payload) => dispatch(config, payload)),
                Effect.catchAllCause(() => Effect.fail(new QueueOperationError())),
              ),
            );
        },
      ),
    catch: () => new QueueOperationError(),
  });
  yield* Effect.tryPromise({
    try: () =>
      boss.work(cleanupQueue, { batchSize: 1, pollingIntervalSeconds: 1 }, () =>
        run(cleanup.pipe(Effect.catchAllCause(() => Effect.fail(new QueueOperationError())))),
      ),
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
      },
      catch: () => new QueueOperationError(),
    }),
  };
});
