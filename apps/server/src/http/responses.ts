import { Schema } from "effect";
import {
  ErrorCode as DomainErrorCode,
  Snapshot,
  VerificationResult,
  DeliveryResult,
  type OperationResult,
} from "@otp-router/engine";
export const ErrorCode = Schema.Union([
  DomainErrorCode,
  Schema.Literals(["unauthorized", "request_too_large", "internal_error"]),
]);
export type ErrorCode = typeof ErrorCode.Type;
export const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: ErrorCode,
    message: Schema.String,
    requestId: Schema.String,
    retryAt: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.Literal("locked")),
  }),
});
export const ResponseBody = Schema.Union([Snapshot, VerificationResult, DeliveryResult, ErrorBody]);

export const statusForError = (code: ErrorCode): number => {
  switch (code) {
    case "invalid_request":
      return 400;
    case "unauthorized":
      return 401;
    case "challenge_not_found":
      return 404;
    case "idempotency_conflict":
    case "request_in_progress":
    case "challenge_state_conflict":
      return 409;
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

export const statusForOutcome = (outcome: OperationResult["outcome"]): number => {
  switch (outcome) {
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
