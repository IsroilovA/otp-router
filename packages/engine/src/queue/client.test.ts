import { expect, it } from "@effect/vitest";
import { Redacted, Effect, Exit, Fiber, Layer } from "effect";
import { PgBoss } from "pg-boss";
import { vi } from "vitest";
import { makeQueueLayer } from "./client.js";

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
