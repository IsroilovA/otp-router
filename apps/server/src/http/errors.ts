import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import {
  statusForError,
  type ErrorCode,
  type ErrorBody as ErrorBodySchema,
  type ResponseBody as ResponseBodySchema,
} from "./responses.js";

export const errorMessages = {
  project_not_found: "The project was not found.",
  project_access_denied: "Project access is denied.",
  project_inactive: "The project is not active.",
  admin_forbidden: "Administration permission is denied.",
  revision_conflict: "The resource revision has changed.",
  resource_not_found: "The runtime resource was not found.",
  resource_conflict: "The runtime resource identity is already reserved.",
  project_conflict: "The project state conflicts with this request.",
  invalid_request: "The request is invalid.",
  history_cursor_expired: "The history cursor is outside the reconciliation window.",
  operation_not_found: "The delivery operation was not found.",
  operation_unavailable: "The delivery operation is no longer available.",
  operation_state_conflict: "The code is already attached.",
  managed_operation: "Use the owning challenge API.",
  unauthorized: "Authentication failed.",
  challenge_not_found: "The challenge was not found.",
  idempotency_conflict: "The idempotency key was already used with different input.",
  request_in_progress: "A request with this idempotency key is still in progress.",
  challenge_state_conflict: "The challenge state does not allow this operation.",
  challenge_unavailable: "The challenge is no longer available.",
  request_too_large: "The request body is too large.",
  incorrect_code: "The submitted code is incorrect.",
  invalid_recipient: "The recipient is invalid.",
  delivery_option_not_allowed: "The delivery option is not allowed.",
  policy_not_allowed: "The policy is not allowed for this purpose.",
  delivery_unavailable: "No eligible delivery route is available.",
  rate_limited: "The request is rate limited.",
  cooldown_active: "The delivery cooldown is active.",
  internal_error: "The request could not be completed.",
  temporarily_unavailable: "The service is temporarily unavailable.",
} satisfies Record<ErrorCode, string>;

type ErrorBody = typeof ErrorBodySchema.Type;
type ResponseBody = typeof ResponseBodySchema.Type;

const makeErrorBody = (code: ErrorCode, requestId: string, retryAt?: string): ErrorBody => ({
  error:
    code === "incorrect_code"
      ? {
          code,
          message: errorMessages[code],
          requestId,
          ...(retryAt === undefined ? {} : { retryAt }),
        }
      : {
          code,
          message: errorMessages[code],
          requestId,
          ...(retryAt === undefined ? {} : { retryAt }),
        },
});

const retryAfter = (retryAt: string): string | undefined => {
  const timestamp = Date.parse(retryAt);
  if (!Number.isFinite(timestamp)) return undefined;
  return String(Math.max(0, Math.ceil((timestamp - Date.now()) / 1000)));
};

export const responseHeaders = (replayed: boolean, body: ResponseBody): Record<string, string> => {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (replayed) headers["idempotency-replayed"] = "true";
  if ("error" in body && body.error.retryAt !== undefined) {
    const value = retryAfter(body.error.retryAt);
    if (value !== undefined) headers["retry-after"] = value;
  }
  return headers;
};
export const errorResponse = (code: ErrorCode, requestId: string, retryAt?: string) => {
  const body = makeErrorBody(code, requestId, retryAt);
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(body, {
      status: statusForError(code),
      headers: responseHeaders(false, body),
    }),
  );
};
