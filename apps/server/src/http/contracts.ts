import { Context, Schema } from "effect";
import { HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "effect/unstable/httpapi";
import { Opaque } from "@otp-router/engine/challenges";
import {
  ForbiddenError,
  ProjectConflictError,
  ProjectNotFoundError,
  InvalidRequestError,
  UnauthorizedError,
  InternalError,
  TemporarilyUnavailableError,
  ConflictError,
  NotFoundError,
  UnavailableChallengeError,
  RequestTooLargeError,
  UnprocessableError,
  RateLimitError,
  RevisionConflictError,
} from "./responses.js";

export const MutationHeaders = Schema.Struct({
  "idempotency-key": Opaque.annotate({
    description: "Operation key reused only when retrying the same request",
  }),
});

export class RequestContext extends Context.Service<
  RequestContext,
  { readonly requestId: string; readonly projectId: string; readonly principalId: string }
>()("otp-router/http/RequestContext") {}

export class ApplicationAuth extends HttpApiMiddleware.Service<
  ApplicationAuth,
  { provides: RequestContext }
>()("otp-router/http/ApplicationAuth", {
  error: UnauthorizedError.pipe(HttpApiSchema.status(401)),
  security: { bearer: HttpApiSecurity.bearer },
}) {}

export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  "otp-router/http/RequestValidation",
  {
    error: [
      InvalidRequestError.pipe(HttpApiSchema.status(400)),
      InternalError.pipe(HttpApiSchema.status(500)),
    ],
  },
) {}

export const commonErrors = [
  ForbiddenError.pipe(HttpApiSchema.status(403)),
  ProjectConflictError.pipe(HttpApiSchema.status(409)),
  ProjectNotFoundError.pipe(HttpApiSchema.status(404)),
  InvalidRequestError.pipe(HttpApiSchema.status(400)),
  UnauthorizedError.pipe(HttpApiSchema.status(401)),
  InternalError.pipe(HttpApiSchema.status(500)),
  TemporarilyUnavailableError.pipe(HttpApiSchema.status(503)),
];
export const conflict = ConflictError.pipe(HttpApiSchema.status(409));
export const notFound = NotFoundError.pipe(HttpApiSchema.status(404));
export const unavailable = UnavailableChallengeError.pipe(HttpApiSchema.status(410));
export const tooLarge = RequestTooLargeError.pipe(HttpApiSchema.status(413));
export const unprocessable = UnprocessableError.pipe(HttpApiSchema.status(422));
export const rateLimit = RateLimitError.pipe(HttpApiSchema.status(429));
export const HistoryQuery = {
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
};
export class AdminContext extends Context.Service<
  AdminContext,
  { readonly actorId: string; readonly requestId: string }
>()("otp-router/http/AdminContext") {}
export class AdminAuth extends HttpApiMiddleware.Service<AdminAuth, { provides: AdminContext }>()(
  "otp-router/http/AdminAuth",
  {
    error: UnauthorizedError.pipe(HttpApiSchema.status(401)),
    security: { bearer: HttpApiSecurity.bearer },
  },
) {}
export const RevisionHeaders = Schema.Struct({
  ...MutationHeaders.fields,
  "if-match": Schema.String.check(Schema.isPattern(/^"[1-9][0-9]{0,9}"$/u)),
});
export const adminErrors = [
  ...commonErrors,
  conflict,
  tooLarge,
  RevisionConflictError.pipe(HttpApiSchema.status(412)),
];
