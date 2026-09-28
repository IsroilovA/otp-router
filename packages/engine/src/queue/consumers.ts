import { Effect } from "effect";
import type { PgBoss } from "pg-boss";
import {
  cleanupQueue,
  deliveryQueue,
  expiryQueue,
  notificationQueue,
  QueueOperationError,
  type QueueName,
} from "./contracts.js";

// Payloads are untrusted persisted input. Worker handlers validate them before dispatch.
type ClaimedJob = { readonly id: string; readonly data: unknown };
type Registration = {
  readonly queue: QueueName;
  readonly concurrency: number;
  readonly pollingIntervalSeconds: number;
};

export const makeConsumers = (boss: PgBoss, shutdownGraceMs: number) =>
  Effect.gen(function* () {
    const controllers = new Set<AbortController>();
    const running = new Set<Promise<void>>();
    let healthy = false;
    let closing = false;
    const stopped = () => {
      healthy = false;
      closing = true;
    };
    const interrupt = () => {
      for (const controller of controllers) controller.abort();
    };
    const stopClaims = Effect.tryPromise({
      try: async () => {
        stopped();
        const results = await Promise.allSettled(
          [deliveryQueue, cleanupQueue, notificationQueue, expiryQueue].map((queue) =>
            boss.offWork(queue, { wait: false }),
          ),
        );
        if (results.some((result) => result.status === "rejected")) throw new QueueOperationError();
      },
      catch: () => new QueueOperationError(),
    }).pipe(Effect.uninterruptible);
    const awaitRunning = Effect.promise(() => Promise.allSettled(running)).pipe(Effect.asVoid);
    const drain = awaitRunning.pipe(
      Effect.timeout(shutdownGraceMs),
      Effect.catchTag("TimeoutError", () =>
        Effect.sync(interrupt).pipe(Effect.andThen(awaitRunning)),
      ),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => boss.on("stopped", stopped)),
      () =>
        stopClaims.pipe(
          Effect.orDie,
          Effect.ensuring(drain),
          Effect.ensuring(Effect.sync(() => boss.off("stopped", stopped))),
        ),
    );

    return {
      isRunning: () => healthy,
      interrupt,
      stopClaims,
      ready: Effect.sync(() => {
        healthy = !closing;
      }),
      register: <R>(
        registration: Registration,
        handler: (job: ClaimedJob) => Effect.Effect<void, QueueOperationError, R>,
      ) =>
        Effect.gen(function* () {
          const runtime = yield* Effect.context<R>();
          yield* Effect.tryPromise({
            try: () =>
              boss.work<unknown, void>(
                registration.queue,
                {
                  batchSize: 1,
                  localConcurrency: registration.concurrency,
                  pollingIntervalSeconds: registration.pollingIntervalSeconds,
                },
                async (jobs) => {
                  for (const job of jobs) {
                    // A claim already in flight can arrive after offWork. Leave it for redelivery.
                    if (closing) throw new QueueOperationError();
                    const controller = new AbortController();
                    controllers.add(controller);
                    const promise = Effect.runPromiseWith(runtime)(
                      Effect.suspend(() => handler(job)),
                      {
                        signal: controller.signal,
                      },
                    );
                    running.add(promise);
                    try {
                      await promise;
                    } finally {
                      controllers.delete(controller);
                      running.delete(promise);
                    }
                  }
                },
              ),
            catch: () => new QueueOperationError(),
          }).pipe(Effect.uninterruptible);
        }),
      scheduleCleanup: Effect.tryPromise({
        try: () => boss.schedule(cleanupQueue, "* * * * *", { version: 1 }),
        catch: () => new QueueOperationError(),
      }).pipe(Effect.uninterruptible),
    };
  });
