import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Fiber, Layer } from "effect";
import { PgBoss } from "pg-boss";
import { vi } from "vitest";
import { QueueLive } from "./client.js";

const config = ConfigProvider.fromMap(
  new Map([["DATABASE_URL", "postgres://test:secret@localhost/test"]]),
);
const buildQueue = Layer.build(QueueLive).pipe(Effect.scoped, Effect.withConfigProvider(config));

it.effect("cleans up failed startup and omits the driver's sensitive error", () =>
  Effect.gen(function* () {
    vi.spyOn(PgBoss.prototype, "start").mockRejectedValue(new Error("password=secret"));
    const stop = vi.spyOn(PgBoss.prototype, "stop").mockResolvedValue(undefined);
    const result = yield* Effect.either(buildQueue);
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "QueueLifecycleError", operation: "start" },
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
    const fiber = yield* Effect.fork(buildQueue);
    const boss = yield* Effect.promise(() => started.promise);
    yield* Fiber.interruptFork(fiber);
    expect(stop).not.toHaveBeenCalled();
    finish.resolve(boss);
    const result = yield* Fiber.await(fiber);
    expect(Exit.isInterrupted(result)).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(boss.listenerCount("error")).toBe(0);
    expect(boss.listenerCount("warning")).toBe(0);
  }),
);
