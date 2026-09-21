import { Effect, type Schema, type Cause } from "effect";
import type { SqlError } from "effect/unstable/sql";
import type { QueueOperationError } from "../queue/jobs.js";
import { DomainError } from "../errors.js";
import { logEvent, type ApplicationOperation, type FailureCategory } from "./log.js";
import { count } from "./metrics.js";
export type InfrastructureError =
  | SqlError.SqlError
  | Schema.SchemaError
  | Cause.NoSuchElementError
  | QueueOperationError;

const sqlFailureCategories = {
  ConnectionError: "database_connection",
  AuthenticationError: "database_authentication",
  AuthorizationError: "database_authorization",
  SqlSyntaxError: "database_syntax",
  UniqueViolation: "database_unique_violation",
  ConstraintError: "database_constraint",
  DeadlockError: "database_deadlock",
  SerializationError: "database_serialization",
  LockTimeoutError: "database_lock_timeout",
  StatementTimeoutError: "database_statement_timeout",
  UnknownError: "database_unknown",
} satisfies Record<SqlError.SqlErrorReason["_tag"], FailureCategory>;

export const failureCategory = (
  error: DomainError | InfrastructureError,
): FailureCategory | undefined => {
  switch (error._tag) {
    case "DomainError":
      return undefined;
    case "SqlError":
      return sqlFailureCategories[error.reason._tag];
    case "QueueOperationError":
      return "queue_operation";
    case "SchemaError":
      return "schema_validation";
    case "NoSuchElementError":
      return "missing_data";
  }
};

// Observe expected failures before normalizing infrastructure details for callers.
// tapError/mapError leave defects and interruption in their original Cause channels.
export const observeOperation = <A extends { readonly outcome: string }, E extends DomainError, R>(
  operation: ApplicationOperation,
  effect: Effect.Effect<A, E | InfrastructureError, R>,
  requestId?: string,
) =>
  effect.pipe(
    Effect.tap((result) =>
      count(operation, result.outcome === "incorrect_code" ? "incorrect_code" : "completed"),
    ),
    Effect.tap((result) =>
      logEvent({
        event: "application_operation",
        operation,
        outcome: `${operation}:${result.outcome}`,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    ),
    Effect.tapError((error) => {
      const reason = error instanceof DomainError ? error.code : "temporarily_unavailable";
      const category = failureCategory(error);
      return count(operation, reason).pipe(
        Effect.andThen(
          logEvent({
            event: "application_operation",
            operation,
            outcome: "rejected",
            reason,
            ...(category === undefined ? {} : { failureCategory: category }),
            ...(requestId === undefined ? {} : { requestId }),
          }),
        ),
      );
    }),
    Effect.mapError((error) =>
      error instanceof DomainError ? error : new DomainError({ code: "temporarily_unavailable" }),
    ),
  );
