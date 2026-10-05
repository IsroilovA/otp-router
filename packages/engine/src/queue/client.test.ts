import { expect, it } from "@effect/vitest";
import { Redacted, Context, Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { PgBoss, type Job } from "pg-boss";
import { vi } from "vitest";
import { makeQueueLayer, Queue } from "./client.js";
import { deliveryQueue } from "./contracts.js";

const buildQueue = Layer.build(
  makeQueueLayer(Redacted.make("postgres://test:secret@localhost/test")),
).pipe(Effect.scoped);

it.effect("cleans up failed startup and omits the driver's sensitive error", () =>
  Effect.gen(function* () {
    vi.spyOn(PgBoss.prototype, "start").mockRejectedValue(new Error("password=secret"));
    const stop = vi.spyOn(PgBoss.prototype, "stop").mockResolvedValue(undefined);
    const result = yield* Effect.result(buildQueue);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "QueueLifecycleError", operation: "start" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(stop).toHaveBeenCalledOnce();
  }),
);

it.effect("waits for in-flight startup before releasing an interrupted scope", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<PgBoss>();
    const finish = Promise.withResolvers<PgBoss>();
    vi.spyOn(PgBoss.prototype, "start").mockImplementation(function (this: PgBoss) {
      started.resolve(this);
      return finish.promise;
    });
    const stop = vi.spyOn(PgBoss.prototype, "stop").mockResolvedValue(undefined);
    const fiber = yield* Effect.forkChild(buildQueue);
    const boss = yield* Effect.promise(() => started.promise);
    yield* Effect.forkChild(Fiber.interrupt(fiber));
    yield* Effect.yieldNow;
    expect(stop).not.toHaveBeenCalled();
    finish.resolve(boss);
    const result = yield* Fiber.await(fiber);
    expect(Exit.hasInterrupts(result)).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(boss.listenerCount("error")).toBe(0);
    expect(boss.listenerCount("warning")).toBe(0);
  }),
);

it.effect(
  "waits for interrupted worker registration before stopping claims and releasing the queue",
  () =>
    Effect.gen(function* () {
      vi.spyOn(PgBoss.prototype, "start").mockImplementation(async function (this: PgBoss) {
        return this;
      });
      const entered = Promise.withResolvers<void>();
      const registered = Promise.withResolvers<string>();
      vi.spyOn(PgBoss.prototype, "work").mockImplementation(() => {
        entered.resolve();
        return registered.promise;
      });
      const stopClaims = vi.spyOn(PgBoss.prototype, "offWork").mockResolvedValue(undefined);
      const stop = vi.spyOn(PgBoss.prototype, "stop").mockResolvedValue(undefined);
      const fiber = yield* Effect.gen(function* () {
        const context = yield* Layer.build(
          makeQueueLayer(Redacted.make("postgres://test:secret@localhost/test")),
        );
        const consumers = yield* Context.get(context, Queue).openConsumers(1000);
        yield* consumers.register(
          { queue: deliveryQueue, concurrency: 1, pollingIntervalSeconds: 0.5 },
          () => Effect.void,
        );
        return yield* Effect.never;
      }).pipe(Effect.scoped, Effect.forkChild);
      yield* Effect.promise(() => entered.promise);
      yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Effect.yieldNow;
      expect(stopClaims).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      registered.resolve("worker");
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(stopClaims).toHaveBeenCalledTimes(4);
      expect(stop).toHaveBeenCalledOnce();
    }),
);

it.effect("drains interrupted job cleanup before releasing resources and rejects late claims", () =>
  Effect.gen(function* () {
    vi.spyOn(PgBoss.prototype, "start").mockImplementation(async function (this: PgBoss) {
      return this;
    });
    const registered = Promise.withResolvers<(jobs: Job<unknown>[]) => Promise<void>>();
    vi.spyOn(PgBoss.prototype, "work").mockImplementation(async (_name, _options, handler) => {
      registered.resolve(async (jobs) => {
        await handler(jobs);
      });
      return "worker";
    });
    const stoppedClaims = Promise.withResolvers<void>();
    vi.spyOn(PgBoss.prototype, "offWork").mockImplementation(async () => {
      stoppedClaims.resolve();
    });
    const stop = vi.spyOn(PgBoss.prototype, "stop").mockResolvedValue(undefined);
    const started = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const cleaned = Promise.withResolvers<void>();
    const invoked = vi.fn<() => void>(() => started.resolve());
    const fiber = yield* Effect.gen(function* () {
      const context = yield* Layer.build(
        makeQueueLayer(Redacted.make("postgres://test:secret@localhost/test")),
      );
      const consumers = yield* Context.get(context, Queue).openConsumers(1000);
      yield* consumers.register(
        { queue: deliveryQueue, concurrency: 1, pollingIntervalSeconds: 0.5 },
        () =>
          Effect.sync(invoked).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.promise(() => {
                cleaning.resolve();
                return cleaned.promise;
              }),
            ),
          ),
      );
      return yield* Effect.never;
    }).pipe(Effect.scoped, Effect.forkChild);
    const handler = yield* Effect.promise(() => registered.promise);
    const job: Job<unknown> = {
      id: "claimed-job",
      retryCount: 0,
      name: deliveryQueue,
      data: {},
      expireInSeconds: 90,
      heartbeatSeconds: null,
      signal: new AbortController().signal,
    };
    const completion = handler([job]).then(
      () => "completed",
      () => "interrupted",
    );
    yield* Effect.promise(() => started.promise);
    yield* Effect.forkChild(Fiber.interrupt(fiber));
    yield* Effect.promise(() => stoppedClaims.promise);
    yield* TestClock.adjust("1 second");
    yield* Effect.promise(() => cleaning.promise);
    expect(stop).not.toHaveBeenCalled();
    const lateClaim = yield* Effect.result(Effect.tryPromise(() => handler([job])));
    expect(lateClaim._tag).toBe("Failure");
    expect(invoked).toHaveBeenCalledOnce();
    cleaned.resolve();
    expect(yield* Effect.promise(() => completion)).toBe("interrupted");
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  }),
);

it.effect("a revoked job interrupts only its handler; shutdown interrupts the remaining work", () =>
  Effect.gen(function* () {
    vi.spyOn(PgBoss.prototype, "start").mockImplementation(async function (this: PgBoss) {
      return this;
    });
    vi.spyOn(PgBoss.prototype, "stop").mockResolvedValue(undefined);
    vi.spyOn(PgBoss.prototype, "offWork").mockResolvedValue(undefined);
    const registered = Promise.withResolvers<(jobs: Job<unknown>[]) => Promise<void>>();
    vi.spyOn(PgBoss.prototype, "work").mockImplementation(async (_name, _options, handler) => {
      registered.resolve(async (jobs) => {
        await handler(jobs);
      });
      return "worker";
    });
    const started = Promise.withResolvers<void>();
    const running = new Set<string>();
    const finalized: string[] = [];
    const context = yield* Layer.build(
      makeQueueLayer(Redacted.make("postgres://test:secret@localhost/test")),
    );
    const consumers = yield* Context.get(context, Queue).openConsumers(1000);
    yield* Effect.addFinalizer(() => Effect.sync(consumers.interrupt));
    yield* consumers.register(
      { queue: deliveryQueue, concurrency: 2, pollingIntervalSeconds: 0.5 },
      (job) =>
        Effect.sync(() => {
          running.add(job.id);
          if (running.size === 2) started.resolve();
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => finalized.push(job.id))),
        ),
    );
    const handler = yield* Effect.promise(() => registered.promise);
    const claim = new AbortController();
    const job: Job<unknown> = {
      id: "revoked-job",
      retryCount: 0,
      name: deliveryQueue,
      data: {},
      expireInSeconds: 90,
      heartbeatSeconds: null,
      signal: claim.signal,
    };
    const revoked = handler([job]).then(
      () => "completed",
      () => "interrupted",
    );
    const retained = handler([
      { ...job, id: "retained-job", signal: new AbortController().signal },
    ]).then(
      () => "completed",
      () => "interrupted",
    );
    yield* Effect.promise(() => started.promise);
    claim.abort();
    expect(yield* Effect.promise(() => revoked)).toBe("interrupted");
    expect(finalized).toEqual(["revoked-job"]);
    expect(yield* Effect.result(Effect.tryPromise(() => handler([job])))).toMatchObject({
      _tag: "Failure",
    });
    expect(finalized).toEqual(["revoked-job"]);
    consumers.interrupt();
    expect(yield* Effect.promise(() => retained)).toBe("interrupted");
    expect(finalized).toEqual(["revoked-job", "retained-job"]);
  }).pipe(Effect.scoped),
);
