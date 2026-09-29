import {
  Snapshot as DeliverySnapshot,
  type OperationResult as ExternalResult,
} from "@otp-router/engine/delivery";
import { Schema } from "effect";
import {
  ErrorCode as DomainErrorCode,
  Snapshot,
  VerificationResult,
  DeliveryResult,
  type OperationResult,
} from "@otp-router/engine/challenges";
export const ErrorCode = Schema.Literals([
  ...DomainErrorCode.literals,
  "unauthorized",
  "request_too_large",
  "internal_error",
]);
export type ErrorCode = typeof ErrorCode.Type;
const ErrorFields = {
  message: Schema.String,
  requestId: Schema.String,
  retryAt: Schema.optionalKey(Schema.String),
};
const PlainErrorDetail = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literals(ErrorCode.literals.filter((code) => code !== "incorrect_code")),
});
const IncorrectCodeDetail = Schema.Struct({
  ...ErrorFields,
  code: Schema.Literal("incorrect_code"),
  reason: Schema.optionalKey(Schema.Literal("locked")),
});
const errorEnvelope = <
  Codes extends Schema.Top & { readonly Type: Exclude<ErrorCode, "incorrect_code"> },
>(
  identifier: string,
  codes: Codes,
) =>
  Schema.Struct({
    error: Schema.Struct({
      ...PlainErrorDetail.fields,
      code: codes,
    }),
  }).annotate({ identifier });

export const InvalidRequestError = errorEnvelope(
  "InvalidRequestError",
  Schema.Literal("invalid_request"),
);
export const UnauthorizedError = errorEnvelope("UnauthorizedError", Schema.Literal("unauthorized"));
export const NotFoundError = errorEnvelope(
  "NotFoundError",
  Schema.Literals(["challenge_not_found", "operation_not_found"]),
);
export const ConflictError = errorEnvelope(
  "ConflictError",
  Schema.Literals([
    "idempotency_conflict",
    "request_in_progress",
    "challenge_state_conflict",
    "operation_state_conflict",
    "managed_operation",
  ]),
);
export const UnavailableChallengeError = errorEnvelope(
  "UnavailableChallengeError",
  Schema.Literals(["challenge_unavailable", "operation_unavailable"]),
);
export const RequestTooLargeError = errorEnvelope(
  "RequestTooLargeError",
  Schema.Literal("request_too_large"),
);
export const UnprocessableError = Schema.Struct({
  error: Schema.Union([
    IncorrectCodeDetail,
    Schema.Struct({
      ...PlainErrorDetail.fields,
      code: Schema.Literals([
        "invalid_recipient",
        "delivery_option_not_allowed",
        "policy_not_allowed",
        "delivery_unavailable",
      ]),
    }),
  ]),
}).annotate({ identifier: "UnprocessableError" });
export const RateLimitError = errorEnvelope(
  "RateLimitError",
  Schema.Literals(["rate_limited", "cooldown_active"]),
);
export const InternalError = errorEnvelope("InternalError", Schema.Literal("internal_error"));
export const TemporarilyUnavailableError = errorEnvelope(
  "TemporarilyUnavailableError",
  Schema.Literal("temporarily_unavailable"),
);

export const HistoryCursorExpiredError = errorEnvelope(
  "HistoryCursorExpired",
  Schema.Literal("history_cursor_expired"),
);
export const ErrorBody = Schema.Struct({
  error: Schema.Union([PlainErrorDetail, IncorrectCodeDetail]),
});
export const ResponseBody = Schema.Union([
  DeliverySnapshot,
  Snapshot,
  VerificationResult,
  DeliveryResult,
  ErrorBody,
]);

export const statusForError = (code: ErrorCode): number => {
  switch (code) {
    case "project_access_denied":
    case "admin_forbidden":
      return 403;
    case "revision_conflict":
      return 412;
    case "project_conflict":
    case "project_inactive":
      return 409;
    case "project_not_found":
      return 404;
    case "invalid_request":
      return 400;
    case "unauthorized":
      return 401;
    case "operation_not_found":
    case "challenge_not_found":
      return 404;
    case "idempotency_conflict":
    case "request_in_progress":
    case "managed_operation":
    case "operation_state_conflict":
    case "challenge_state_conflict":
      return 409;
    case "history_cursor_expired":
    case "operation_unavailable":
    case "challenge_unavailable":
      return 410;
    case "request_too_large":
      return 413;
    case "incorrect_code":
    case "invalid_recipient":
    case "delivery_option_not_allowed":
    case "policy_not_allowed":
    case "delivery_unavailable":
      return 422;
    case "rate_limited":
    case "cooldown_active":
      return 429;
    case "internal_error":
      return 500;
    case "temporarily_unavailable":
      return 503;
  }
};

export const statusForOutcome = (
  outcome: OperationResult["outcome"] | ExternalResult["outcome"],
): number => {
  switch (outcome) {
    case "prepared":
    case "created":
      return 201;
    case "completed":
      return 200;
    case "delivery_queued":
      return 202;
    case "incorrect_code":
      return 422;
  }
};

export const ForbiddenError = errorEnvelope(
  "ForbiddenError",
  Schema.Literals(["project_access_denied", "admin_forbidden"]),
);
export const ProjectConflictError = errorEnvelope(
  "ProjectConflictError",
  Schema.Literals(["project_conflict", "project_inactive"]),
);
export const RevisionConflictError = errorEnvelope(
  "RevisionConflictError",
  Schema.Literal("revision_conflict"),
);
export const ProjectNotFoundError = errorEnvelope(
  "ProjectNotFoundError",
  Schema.Literal("project_not_found"),
);
