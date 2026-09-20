import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "effect/unstable/httpapi";
import { Context, Schema } from "effect";
import {
  Opaque,
  CreateInput,
  DeliveryInput,
  DeliveryResult,
  Snapshot,
  VerificationResult,
  VerifyInput,
} from "../challenges/contracts.js";

const MutationHeaders = Schema.Struct({
  "idempotency-key": Opaque.annotate({
    description: "Operation key reused only when retrying the same request",
  }),
});

const errorEnvelope = <Codes extends Schema.Top>(identifier: string, codes: Codes) =>
  Schema.Struct({
    error: Schema.Struct({
      code: codes,
      message: Schema.String,
      requestId: Schema.String,
      retryAt: Schema.optionalKey(Schema.String),
    }),
  }).annotate({ identifier });

const InvalidRequestError = errorEnvelope("InvalidRequestError", Schema.Literal("invalid_request"));
export const UnauthorizedError = errorEnvelope("UnauthorizedError", Schema.Literal("unauthorized"));
export class RequestContext extends Context.Service<
  RequestContext,
  { readonly requestId: string }
>()("otp-router/http/RequestContext") {}

export class ApplicationAuth extends HttpApiMiddleware.Service<
  ApplicationAuth,
  { provides: RequestContext }
>()("otp-router/http/ApplicationAuth", {
  error: UnauthorizedError.pipe(HttpApiSchema.status(401)),
  security: { bearer: HttpApiSecurity.bearer },
}) {}

const NotFoundError = errorEnvelope("NotFoundError", Schema.Literal("challenge_not_found"));
const ConflictError = errorEnvelope(
  "ConflictError",
  Schema.Literals(["idempotency_conflict", "request_in_progress", "challenge_state_conflict"]),
);
const UnavailableChallengeError = errorEnvelope(
  "UnavailableChallengeError",
  Schema.Literal("challenge_unavailable"),
);
const RequestTooLargeError = errorEnvelope(
  "RequestTooLargeError",
  Schema.Literal("request_too_large"),
);
const UnprocessableError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literals([
      "incorrect_code",
      "invalid_recipient",
      "delivery_option_not_allowed",
      "policy_not_allowed",
      "delivery_unavailable",
    ]),
    message: Schema.String,
    requestId: Schema.String,
    retryAt: Schema.optionalKey(Schema.String),
    verificationState: Schema.optionalKey(Schema.Literals(["active", "locked"])),
  }),
}).annotate({ identifier: "UnprocessableError" });
const RateLimitError = errorEnvelope(
  "RateLimitError",
  Schema.Literals(["rate_limited", "cooldown_active"]),
);
const InternalError = errorEnvelope("InternalError", Schema.Literal("internal_error"));
const TemporarilyUnavailableError = errorEnvelope(
  "TemporarilyUnavailableError",
  Schema.Literal("temporarily_unavailable"),
);

export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  "otp-router/http/RequestValidation",
  {
    error: [
      InvalidRequestError.pipe(HttpApiSchema.status(400)),
      InternalError.pipe(HttpApiSchema.status(500)),
    ],
  },
) {}

const commonErrors = [
  InvalidRequestError.pipe(HttpApiSchema.status(400)),
  UnauthorizedError.pipe(HttpApiSchema.status(401)),
  InternalError.pipe(HttpApiSchema.status(500)),
  TemporarilyUnavailableError.pipe(HttpApiSchema.status(503)),
];
const conflict = ConflictError.pipe(HttpApiSchema.status(409));
const notFound = NotFoundError.pipe(HttpApiSchema.status(404));
const unavailable = UnavailableChallengeError.pipe(HttpApiSchema.status(410));
const tooLarge = RequestTooLargeError.pipe(HttpApiSchema.status(413));
const unprocessable = UnprocessableError.pipe(HttpApiSchema.status(422));
const rateLimit = RateLimitError.pipe(HttpApiSchema.status(429));
const params = { challengeId: Schema.String };

const ApplicationGroup = HttpApiGroup.make("application").add(
  HttpApiEndpoint.post("createChallenge", "/v1/challenges", {
    headers: MutationHeaders,
    payload: CreateInput,
    success: Snapshot.pipe(HttpApiSchema.status(201)),
    error: [...commonErrors, conflict, tooLarge, unprocessable, rateLimit],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth)
    .annotateMerge(
      OpenApi.annotations({ summary: "Create a challenge and queue its initial delivery" }),
    ),
  HttpApiEndpoint.get("getChallengeStatus", "/v1/challenges/:challengeId", {
    params,
    success: Snapshot,
    error: [...commonErrors, notFound],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth)
    .annotateMerge(OpenApi.annotations({ summary: "Read the current challenge snapshot" })),
  HttpApiEndpoint.post("verifyChallenge", "/v1/challenges/:challengeId/verify", {
    params,
    headers: MutationHeaders,
    payload: VerifyInput,
    success: VerificationResult,
    error: [...commonErrors, notFound, conflict, unavailable, tooLarge, unprocessable, rateLimit],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth)
    .annotateMerge(OpenApi.annotations({ summary: "Verify a challenge" })),
  HttpApiEndpoint.post("scheduleDelivery", "/v1/challenges/:challengeId/deliveries", {
    params,
    headers: MutationHeaders,
    payload: DeliveryInput,
    success: DeliveryResult.pipe(HttpApiSchema.status(202)),
    error: [...commonErrors, notFound, conflict, unavailable, tooLarge, unprocessable, rateLimit],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth)
    .annotateMerge(
      OpenApi.annotations({ summary: "Queue a resend, next route, or manual selection" }),
    ),
  HttpApiEndpoint.post("cancelChallenge", "/v1/challenges/:challengeId/cancel", {
    params,
    headers: MutationHeaders,
    payload: Schema.Struct({}),
    success: Snapshot,
    error: [...commonErrors, notFound, conflict, tooLarge],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth)
    .annotateMerge(OpenApi.annotations({ summary: "Cancel an active challenge" })),
);
const WebhookGroup = HttpApiGroup.make("providerCallbacks").add(
  HttpApiEndpoint.get("providerHandshake", "/webhooks/:providerInstanceId", {
    params: { providerInstanceId: Schema.String },
    success: Schema.String.pipe(HttpApiSchema.asText()),
    error: [
      HttpApiSchema.Empty(400),
      HttpApiSchema.Empty(401),
      HttpApiSchema.Empty(404),
      HttpApiSchema.Empty(503),
    ],
  }),
  HttpApiEndpoint.post("providerCallback", "/webhooks/:providerInstanceId", {
    params: { providerInstanceId: Schema.String },
    payload: Schema.Uint8Array.pipe(
      HttpApiSchema.asUint8Array({ contentType: "application/json" }),
    ),
    success: HttpApiSchema.Empty(200),
    error: [
      HttpApiSchema.Empty(400),
      HttpApiSchema.Empty(401),
      HttpApiSchema.Empty(404),
      HttpApiSchema.Empty(413),
      HttpApiSchema.Empty(503),
    ],
  }),
);
export const OtpRouterApi = HttpApi.make("otpRouter")
  .add(ApplicationGroup, WebhookGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "OTP Router API",
      version: "1.0.0",
      description: "Backend challenge operations and provider callback ingress.",
    }),
  );
export const openApiDocument = OpenApi.fromApi(OtpRouterApi);
