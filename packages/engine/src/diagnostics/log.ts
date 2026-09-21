import { Effect } from "effect";
import type { ErrorCode } from "../errors.js";
export type ApplicationOperation =
  | "delivery.prepare"
  | "delivery.create"
  | "delivery.submitCode"
  | "delivery.deliver"
  | "delivery.close"
  | "delivery.status"
  | "create"
  | "verify"
  | "cancel"
  | "deliver"
  | "status";
export type FailureCategory =
  | "database_connection"
  | "database_authentication"
  | "database_authorization"
  | "database_syntax"
  | "database_unique_violation"
  | "database_constraint"
  | "database_deadlock"
  | "database_serialization"
  | "database_lock_timeout"
  | "database_statement_timeout"
  | "database_unknown"
  | "queue_operation"
  | "schema_validation"
  | "missing_data"
  | "domain_rejection"
  | "provider_failure"
  | "timeout"
  | "crypto_failure"
  | "correlation_conflict"
  | "defect"
  | "interrupted";
export interface Diagnostic {
  readonly event:
    | "application_operation"
    | "provider_send"
    | "callback"
    | "recovery"
    | "worker_failure";
  readonly requestId?: string;
  readonly jobId?: string;
  readonly queue?: string;
  readonly operationId?: string;
  readonly attemptId?: string;
  readonly providerInstanceId?: string;
  readonly outcome: string;
  readonly reason?: ErrorCode;
  readonly operation?: ApplicationOperation;
  readonly failureCategory?: FailureCategory;
  readonly elapsedMilliseconds?: number;
}
// Only callers with normalized fields cross this boundary. Never accept an error/Cause or request object.
export const logEvent = (diagnostic: Diagnostic) =>
  Effect.sync(() => {
    process.stdout.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), level: "info", ...diagnostic })}\n`,
    );
  }).pipe(Effect.catchCause(() => Effect.void));
