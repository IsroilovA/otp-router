import { Context, Data, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { PgBoss, type SendOptions } from "pg-boss";
import { makeConsumers } from "./consumers.js";
import {
  cleanupQueue,
  deliveryQueue,
  expiryQueue,
  notificationQueue,
  QueueOperationError,
  type DeliveryJob,
  type QueueName,
} from "./contracts.js";

export class QueueLifecycleError extends Data.TaggedError("QueueLifecycleError")<{
  readonly operation: "create" | "start" | "stop";
}> {}

const enqueue = (boss: PgBoss, name: QueueName, job: object, options: SendOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
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

const initialize = (boss: PgBoss) =>
  Effect.tryPromise({
    try: async () => {
      await boss.createQueue(deliveryQueue);
      await boss.createQueue(notificationQueue, { policy: "short" });
      await boss.createQueue(expiryQueue, { policy: "short" });
      await boss.createQueue(cleanupQueue);
    },
    catch: () => new QueueOperationError(),
  }).pipe(Effect.uninterruptible);

const makeQueue = (url: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.context<never>();
    // EventEmitter callbacks are an external runtime boundary. Never log raw errors.
    const onError = () => Effect.runSyncWith(runtime)(Effect.logError("pg-boss background error"));
    const onWarning = () => Effect.runSyncWith(runtime)(Effect.logWarning("pg-boss warning"));
    const client = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const boss = new PgBoss({
            connectionString: Redacted.value(url),
            application_name: "otp_router_queue",
            max: 6,
            connectionTimeoutMillis: 5000,
            monitorIntervalSeconds: 10,
          });
          boss.on("error", onError);
          boss.on("warning", onWarning);
          return boss;
        },
        catch: () => new QueueLifecycleError({ operation: "create" }),
      }),
      (boss) =>
        Effect.tryPromise({
          try: () => boss.stop({ graceful: true, close: true, timeout: 30_000 }),
          catch: () => new QueueLifecycleError({ operation: "stop" }),
        }).pipe(
          Effect.orDie,
          Effect.ensuring(
            Effect.sync(() => {
              boss.off("error", onError);
              boss.off("warning", onWarning);
            }),
          ),
        ),
    );
    // pg-boss start cannot be aborted; await it before allowing scope cleanup.
    yield* Effect.tryPromise({
      try: () => client.start(),
      catch: () => new QueueLifecycleError({ operation: "start" }),
    }).pipe(Effect.uninterruptible);
    return {
      initialize: initialize(client),
      enqueueDelivery: (job: DeliveryJob) => enqueue(client, deliveryQueue, job),
      enqueueNotification: (eventId: string, time: Date) =>
        enqueue(
          client,
          notificationQueue,
          { eventId },
          { startAfter: time, singletonKey: eventId },
        ),
      enqueueExpiry: (operationId: string, time: Date) =>
        enqueue(
          client,
          expiryQueue,
          { operationId },
          { startAfter: time, singletonKey: operationId },
        ),
      openConsumers: (shutdownGraceMs: number) => makeConsumers(client, shutdownGraceMs),
    };
  });

export class Queue extends Context.Service<Queue, Effect.Success<ReturnType<typeof makeQueue>>>()(
  "otp-router/Queue",
) {}

export const makeQueueLayer = (url: Redacted.Redacted<string>) =>
  Layer.effect(Queue, makeQueue(url));
