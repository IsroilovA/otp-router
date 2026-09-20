import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import { fetchTransport } from "./transport.js";

it.effect("aborts a timed-out fetch without retrying the provider request", () =>
  Effect.gen(function* () {
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetch);
    const fiber = yield* fetchTransport
      .execute({
        url: "https://provider.invalid/send",
        method: "POST",
        headers: {},
        body: new Uint8Array(),
      })
      .pipe(Effect.timeout("1 second"), Effect.forkChild);
    yield* TestClock.adjust("1 second");
    expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  }),
);

it.effect("aborts a timed-out response body without retrying the provider request", () =>
  Effect.gen(function* () {
    let signal: AbortSignal | null | undefined;
    const reading = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      signal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              start(controller) {
                signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
                  once: true,
                });
              },
              pull() {
                reading.resolve();
              },
            },
            { highWaterMark: 0 },
          ),
        ),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const fiber = yield* fetchTransport
      .execute({
        url: "https://provider.invalid/send",
        method: "POST",
        headers: {},
        body: new Uint8Array(),
      })
      .pipe(Effect.timeout("1 second"), Effect.forkChild);
    yield* Effect.promise(() => reading.promise);
    yield* TestClock.adjust("1 second");
    expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  }),
);
