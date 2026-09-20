import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
  OpenApi,
} from "@effect/platform";
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
  "idempotency-key": Opaque.annotations({
    description: "Operation key reused only when retrying the same request",
  }),
});

const ChallengeId = HttpApiSchema.param("challengeId", Schema.String);
const ProviderInstanceId = HttpApiSchema.param("providerInstanceId", Schema.String);

const errorEnvelope = <Codes extends Schema.Schema.All>(identifier: string, codes: Codes) =>
  Schema.Struct({
    error: Schema.Struct({
      code: codes,
      message: Schema.String,
      requestId: Schema.String,
      retryAt: Schema.optional(Schema.String),
    }),
  }).annotations({ identifier });

const InvalidRequestError = errorEnvelope("InvalidRequestError", Schema.Literal("invalid_request"));
export const UnauthorizedError = errorEnvelope("UnauthorizedError", Schema.Literal("unauthorized"));
export class RequestContext extends Context.Tag("otp-router/http/RequestContext")<
  RequestContext,
  { readonly requestId: string }
>() {}

export class ApplicationAuth extends HttpApiMiddleware.Tag<ApplicationAuth>()(
  "otp-router/http/ApplicationAuth",
  {
    provides: RequestContext,
    failure: UnauthorizedError.annotations(HttpApiSchema.annotations({ status: 401 })),
    security: { bearer: HttpApiSecurity.bearer },
  },
) {}

const NotFoundError = errorEnvelope("NotFoundError", Schema.Literal("challenge_not_found"));
const ConflictError = errorEnvelope(
  "ConflictError",
  Schema.Literal("idempotency_conflict", "request_in_progress", "challenge_state_conflict"),
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
    code: Schema.Literal(
      "incorrect_code",
      "invalid_recipient",
      "delivery_option_not_allowed",
      "policy_not_allowed",
      "delivery_unavailable",
    ),
    message: Schema.String,
    requestId: Schema.String,
    retryAt: Schema.optional(Schema.String),
    verificationState: Schema.optional(Schema.Literal("active", "locked")),
  }),
}).annotations({ identifier: "UnprocessableError" });
const RateLimitError = errorEnvelope(
  "RateLimitError",
  Schema.Literal("rate_limited", "cooldown_active"),
);
const InternalError = errorEnvelope("InternalError", Schema.Literal("internal_error"));
const TemporarilyUnavailableError = errorEnvelope(
  "TemporarilyUnavailableError",
  Schema.Literal("temporarily_unavailable"),
);

const addCommonErrors = <
  Name extends string,
  Method extends "GET" | "POST",
  Path,
  UrlParams,
  Payload,
  Headers,
  Success,
  Error,
  R,
  RE,
>(
  endpoint: HttpApiEndpoint.HttpApiEndpoint<
    Name,
    Method,
    Path,
    UrlParams,
    Payload,
    Headers,
    Success,
    Error,
    R,
    RE
  >,
) =>
  endpoint
    .addError(InvalidRequestError, { status: 400 })
    .addError(UnauthorizedError, { status: 401 })
    .addError(InternalError, { status: 500 })
    .addError(TemporarilyUnavailableError, { status: 503 });

const Create = addCommonErrors(
  HttpApiEndpoint.post("createChallenge", "/v1/challenges")
    .middleware(ApplicationAuth)
    .setHeaders(MutationHeaders)
    .setPayload(CreateInput)
    .addSuccess(Snapshot, { status: 201 }),
)
  .addError(ConflictError, { status: 409 })
  .addError(RequestTooLargeError, { status: 413 })
  .addError(UnprocessableError, { status: 422 })
  .addError(RateLimitError, { status: 429 })
  .annotateContext(
    OpenApi.annotations({
      summary: "Create a challenge and queue its initial delivery",
      description:
        "Commits the challenge, initial delivery record, queue work, and idempotency result before returning.",
    }),
  );

const Status = addCommonErrors(
  HttpApiEndpoint.get("getChallengeStatus")`/v1/challenges/${ChallengeId}`
    .middleware(ApplicationAuth)
    .addSuccess(Snapshot, {
      status: 200,
    }),
)
  .addError(NotFoundError, { status: 404 })
  .annotateContext(
    OpenApi.annotations({
      summary: "Read the current challenge snapshot",
      description: "Reads stored state and does not contact a provider.",
    }),
  );

const Verify = addCommonErrors(
  HttpApiEndpoint.post("verifyChallenge")`/v1/challenges/${ChallengeId}/verify`
    .middleware(ApplicationAuth)
    .setHeaders(MutationHeaders)
    .setPayload(VerifyInput)
    .addSuccess(VerificationResult, { status: 200 }),
)
  .addError(NotFoundError, { status: 404 })
  .addError(ConflictError, { status: 409 })
  .addError(UnavailableChallengeError, { status: 410 })
  .addError(RequestTooLargeError, { status: 413 })
  .addError(UnprocessableError, { status: 422 })
  .addError(RateLimitError, { status: 429 })
  .annotateContext(
    OpenApi.annotations({
      summary: "Verify a challenge",
      description:
        "Checks the stored purpose and context before the code. A matching replay returns the original verification result.",
    }),
  );

const Deliver = addCommonErrors(
  HttpApiEndpoint.post("scheduleDelivery")`/v1/challenges/${ChallengeId}/deliveries`
    .middleware(ApplicationAuth)
    .setHeaders(MutationHeaders)
    .setPayload(DeliveryInput)
    .addSuccess(DeliveryResult, { status: 202 }),
)
  .addError(NotFoundError, { status: 404 })
  .addError(ConflictError, { status: 409 })
  .addError(UnavailableChallengeError, { status: 410 })
  .addError(RequestTooLargeError, { status: 413 })
  .addError(UnprocessableError, { status: 422 })
  .addError(RateLimitError, { status: 429 })
  .annotateContext(
    OpenApi.annotations({
      summary: "Queue a resend, next route, or manual selection",
      description: "Commits a new delivery record and queue work without waiting for a provider.",
    }),
  );

const Cancel = addCommonErrors(
  HttpApiEndpoint.post("cancelChallenge")`/v1/challenges/${ChallengeId}/cancel`
    .middleware(ApplicationAuth)
    .setHeaders(MutationHeaders)
    .setPayload(Schema.Struct({}))
    .addSuccess(Snapshot, { status: 200 }),
)
  .addError(NotFoundError, { status: 404 })
  .addError(ConflictError, { status: 409 })
  .addError(RequestTooLargeError, { status: 413 })
  .annotateContext(
    OpenApi.annotations({
      summary: "Cancel an active challenge",
      description:
        "Cancels pending sends and erases verification secrets in the same committed operation.",
    }),
  );

const ApplicationGroup = HttpApiGroup.make("application")
  .add(Create)
  .add(Status)
  .add(Verify)
  .add(Deliver)
  .add(Cancel)
  .annotateContext(OpenApi.annotations({ description: "Authenticated application API" }));

const WebhookGroup = HttpApiGroup.make("providerCallbacks")
  .add(
    HttpApiEndpoint.get("providerHandshake")`/webhooks/${ProviderInstanceId}`
      .addSuccess(HttpApiSchema.Text(), { status: 200 })
      .addError(HttpApiSchema.Empty(400))
      .addError(HttpApiSchema.Empty(401))
      .addError(HttpApiSchema.Empty(404))
      .addError(HttpApiSchema.Empty(503)),
  )
  .add(
    HttpApiEndpoint.post("providerCallback")`/webhooks/${ProviderInstanceId}`
      .setPayload(HttpApiSchema.Uint8Array({ contentType: "application/json" }))
      .addSuccess(HttpApiSchema.Empty(200))
      .addError(HttpApiSchema.Empty(400))
      .addError(HttpApiSchema.Empty(401))
      .addError(HttpApiSchema.Empty(404))
      .addError(HttpApiSchema.Empty(413))
      .addError(HttpApiSchema.Empty(503)),
  )
  .annotateContext(
    OpenApi.annotations({
      description: "Provider-authenticated handshake and delivery-report callbacks",
    }),
  );

export const OtpRouterApi = HttpApi.make("otpRouter")
  .add(ApplicationGroup)
  .add(WebhookGroup)
  .annotateContext(
    OpenApi.annotations({
      title: "OTP Router API",
      version: "1.0.0",
      description: "Backend challenge operations and provider callback ingress.",
    }),
  );

export const openApiDocument = OpenApi.fromApi(OtpRouterApi, {
  additionalPropertiesStrategy: "strict",
});
