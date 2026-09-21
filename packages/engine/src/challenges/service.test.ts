import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Cause, Effect, Exit, Result, Schema, SchemaIssue } from "effect";
import { SqlError } from "effect/unstable/sql";
import { QueueOperationError } from "../queue/jobs.js";
import { type OperationResult } from "./contracts.js";
import { DomainError } from "../errors.js";
import { observeOperation } from "../diagnostics/operation.js";

const sensitive = "password=private-token recipient=+14155552671 code=123456";

it.effect(
  "classifies infrastructure failures without exposing their payloads to logs or callers",
  () =>
    Effect.gen(function* () {
      const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const cases = [
        {
          error: new SqlError.SqlError({
            reason: new SqlError.ConnectionError({
              cause: new Error(sensitive),
              message: sensitive,
            }),
          }),
          category: "database_connection",
        },
        {
          error: new SqlError.SqlError({
            reason: new SqlError.LockTimeoutError({ cause: sensitive, operation: sensitive }),
          }),
          category: "database_lock_timeout",
        },
        {
          error: new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause: sensitive }) }),
          category: "database_unknown",
        },
        { error: new QueueOperationError(), category: "queue_operation" },
        {
          error: new Schema.SchemaError(new SchemaIssue.InvalidType(Schema.Number.ast, sensitive)),
          category: "schema_validation",
        },
        { error: new Cause.NoSuchElementError(sensitive), category: "missing_data" },
      ];
      for (const { error, category } of cases) {
        output.mockClear();
        const result = yield* observeOperation("create", Effect.fail(error), "request-1").pipe(
          Effect.result,
        );
        expect(result).toEqual(Result.fail(new DomainError({ code: "temporarily_unavailable" })));
        expect(JSON.stringify(result)).not.toContain(sensitive);
        expect(JSON.stringify(result)).not.toContain("failureCategory");
        const logs = output.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(logs).toContain(`"failureCategory":"${category}"`);
        expect(logs).toContain('"operation":"create"');
        expect(logs).toContain('"requestId":"request-1"');
        expect(logs).not.toContain(sensitive);
      }
    }),
);

it.effect("preserves domain rejection details and committed incorrect-code responses", () =>
  Effect.gen(function* () {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const rejection = new DomainError({
      code: "cooldown_active",
      retryAt: "2026-09-20T10:00:30.000Z",
    });
    const rejected = yield* observeOperation("deliver", Effect.fail(rejection)).pipe(Effect.result);
    expect(rejected).toEqual(Result.fail(rejection));
    if (Result.isFailure(rejected)) expect(rejected.failure).toBe(rejection);
    const committed: OperationResult = {
      outcome: "incorrect_code",
      replayed: true,
      body: {
        error: {
          code: "incorrect_code",
          requestId: "original-request",
          reason: "locked",
        },
      },
    };
    const response = yield* observeOperation("verify", Effect.succeed(committed));
    expect(response).toBe(committed);
    const logs = output.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(logs).toContain('"reason":"cooldown_active"');
    expect(logs).not.toContain("failureCategory");
  }),
);

it.effect(
  "preserves defects and interruption instead of classifying them as service failures",
  () =>
    Effect.gen(function* () {
      const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const defect = new Error(sensitive);
      const died = yield* observeOperation("status", Effect.die(defect)).pipe(Effect.exit);
      expect(died).toEqual(Exit.die(defect));
      const interrupted = yield* observeOperation("status", Effect.interrupt).pipe(Effect.exit);
      expect(Exit.isFailure(interrupted)).toBe(true);
      if (Exit.isFailure(interrupted))
        expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
      expect(output).not.toHaveBeenCalled();
    }),
);
