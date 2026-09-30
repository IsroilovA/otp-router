import { Data, Schema } from "effect";
export const ErrorCode = Schema.Literals([
  "invalid_request",
  "project_not_found",
  "project_access_denied",
  "project_inactive",
  "admin_forbidden",
  "revision_conflict",
  "project_conflict",
  "resource_not_found",
  "resource_conflict",
  "history_cursor_expired",
  "operation_not_found",
  "operation_unavailable",
  "operation_state_conflict",
  "managed_operation",
  "challenge_not_found",
  "idempotency_conflict",
  "request_in_progress",
  "challenge_state_conflict",
  "challenge_unavailable",
  "incorrect_code",
  "invalid_recipient",
  "delivery_option_not_allowed",
  "policy_not_allowed",
  "delivery_unavailable",
  "rate_limited",
  "cooldown_active",
  "temporarily_unavailable",
]);
export type ErrorCode = typeof ErrorCode.Type;
export class DomainError<Code extends ErrorCode = ErrorCode> extends Data.TaggedError(
  "DomainError",
)<{
  readonly code: Code;
  readonly retryAt?: string;
}> {}
