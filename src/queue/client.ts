import { Config, Context, Data, Effect, Layer, Redacted, Runtime } from "effect";
import { PgBoss } from "pg-boss";

export class QueueLifecycleError extends Data.TaggedError("QueueLifecycleError")<{
  readonly operation: "create" | "start" | "stop";
}> {}

export class Queue extends Context.Tag("otp-router/Queue")<Queue, PgBoss>() {}

const makeQueue = Effect.gen(function* () {
  const url = yield* Config.redacted("DATABASE_URL");
  const runtime = yield* Effect.runtime<never>();
  // EventEmitter callbacks are an external runtime boundary. Never log raw errors.
  const onError = () => Runtime.runSync(runtime)(Effect.logError("pg-boss background error"));
  const onWarning = () => Runtime.runSync(runtime)(Effect.logWarning("pg-boss warning"));
  const client = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const boss = new PgBoss({
          connectionString: Redacted.value(url),
          application_name: "otp_router_queue",
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
  return client;
});

export const QueueLive = Layer.scoped(Queue, makeQueue);
