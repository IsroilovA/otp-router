import { SqlClient, type SqlError } from "effect/unstable/sql";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, type Cause, Schema } from "effect";
import { RouterConfig } from "../config/runtime.js";

import { Queue } from "../queue/client.js";
import type { QueueOperationError } from "../queue/jobs.js";
import { logEvent, type ApplicationOperation, type FailureCategory } from "../diagnostics/log.js";
import { count } from "../diagnostics/metrics.js";
import { requestDelivery } from "../delivery/actions.js";
import {
  DomainError,
  Router,
  CreateRequest,
  VerifyRequest,
  DeliveryRequest,
  CancelRequest,
  type OperationResult,
} from "./contracts.js";
import { createChallenge } from "./create.js";
import { verifyChallenge } from "./verify.js";
import { cancelChallenge } from "./cancel.js";
import { challengeStatus } from "./status.js";

type InfrastructureError =
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

const failureCategory = (error: DomainError | InfrastructureError): FailureCategory | undefined => {
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
export const observeOperation = <E extends DomainError, R>(
  operation: ApplicationOperation,
  effect: Effect.Effect<OperationResult, E | InfrastructureError, R>,
  requestId?: string,
) =>
  effect.pipe(
    Effect.tap((result) =>
      count(operation, "error" in result.body ? result.body.error.code : "completed"),
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

const validate = <S extends Schema.Top>(schema: S, input: S["Type"]) =>
  Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new DomainError({ code: "invalid_request" })),
  );

export const RouterLive = Layer.effect(
  Router,
  Effect.gen(function* () {
    const config = yield* RouterConfig;
    const pg = yield* PgClient.PgClient;
    const queue = yield* Queue;
    const provide = <A, E>(
      effect: Effect.Effect<A, E, PgClient.PgClient | SqlClient.SqlClient | Queue>,
    ) =>
      effect.pipe(
        Effect.provideService(PgClient.PgClient, pg),
        Effect.provideService(Queue, queue),
        Effect.provideService(SqlClient.SqlClient, pg),
      );
    return {
      create: (request) =>
        observeOperation(
          "create",
          validate(CreateRequest, request).pipe(
            Effect.flatMap((valid) => provide(createChallenge(config, valid))),
          ),
          request.requestId,
        ),
      status: (id) =>
        observeOperation(
          "status",
          validate(Schema.String, id).pipe(
            Effect.flatMap((valid) => provide(challengeStatus(config, valid))),
          ),
        ),
      verify: (request) =>
        observeOperation(
          "verify",
          validate(VerifyRequest, request).pipe(
            Effect.flatMap((valid) => provide(verifyChallenge(config, valid))),
          ),
          request.requestId,
        ),
      cancel: (request) =>
        observeOperation(
          "cancel",
          validate(CancelRequest, request).pipe(
            Effect.flatMap((valid) => provide(cancelChallenge(config, valid))),
          ),
          request.requestId,
        ),
      deliver: (request) =>
        observeOperation(
          "deliver",
          validate(DeliveryRequest, request).pipe(
            Effect.flatMap((valid) => provide(requestDelivery(config, valid))),
          ),
          request.requestId,
        ),
    };
  }),
);
