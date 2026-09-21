import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { SqlError } from "effect/unstable/sql";
import { vi } from "vitest";
import { observeJob } from "./diagnostics.js";

it.effect(
  "redacts worker failures while distinguishing expected errors, defects and interruption",
  () =>
    Effect.gen(function* () {
      const sensitive = "credential=private code=123456 recipient=+14155552671";
      const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const cases = [
        {
          effect: Effect.fail(
            new SqlError.SqlError({
              reason: new SqlError.ConnectionError({ message: sensitive, cause: sensitive }),
            }),
          ),
          category: "database_connection",
        },
        { effect: Effect.die(new Error(sensitive)), category: "defect" },
        { effect: Effect.interrupt, category: "interrupted" },
      ];
      for (const entry of cases) {
        output.mockClear();
        const exit = yield* observeJob(entry.effect, {
          queue: "otp-delivery-v1",
          jobId: "job-1",
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) throw new Error("Expected failure");
        expect(Cause.hasDies(exit.cause)).toBe(entry.category === "defect");
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(entry.category === "interrupted");
        if (entry.category === "database_connection")
          expect(Cause.findErrorOption(exit.cause)).toMatchObject({
            _tag: "Some",
            value: { _tag: "QueueOperationError" },
          });
        const logs = output.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(logs).toContain(`"failureCategory":"${entry.category}"`);
        expect(logs).toContain('"jobId":"job-1"');
        expect(logs).toContain('"queue":"otp-delivery-v1"');
        expect(logs).not.toContain(sensitive);
        expect(JSON.stringify(exit)).not.toContain(sensitive);
      }
    }),
);
