import {
  InvalidRequestError,
  UnauthorizedError,
  NotFoundError,
  ConflictError,
  UnavailableChallengeError,
  RequestTooLargeError,
  UnprocessableError,
  RateLimitError,
  InternalError,
  TemporarilyUnavailableError,
  HistoryCursorExpiredError,
} from "./responses.js";
import {
  AttemptEvent,
  EvidenceEvent,
  EventPage,
  AttemptPage,
  AttemptSnapshot,
  OperationPage,
} from "@otp-router/engine/delivery";
import { DeliveryEvent } from "@otp-router/engine/delivery";
import {
  PrepareInput,
  CreateInput as ExternalCreateInput,
  SubmitInput,
  Snapshot as DeliverySnapshot,
} from "@otp-router/engine/delivery";
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
  ChallengeEvent,
  Opaque,
  CreateInput,
  DeliveryInput,
  DeliveryResult,
  Snapshot,
  VerificationResult,
  VerifyInput,
} from "@otp-router/engine/challenges";

const MutationHeaders = Schema.Struct({
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
const params = { projectId: Schema.String, challengeId: Schema.String };

const HistoryQuery = {
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
};
const HistoryCursorExpired = HistoryCursorExpiredError.pipe(HttpApiSchema.status(410));
const HistoryGroup = HttpApiGroup.make("history").add(
  HttpApiEndpoint.get("events", "/v1/projects/:projectId/events", {
    params: { projectId: Schema.String },
    query: {
      ...HistoryQuery,
      operationId: Schema.optionalKey(Schema.String),
      attemptId: Schema.optionalKey(Schema.String),
    },
    success: EventPage,
    error: [...commonErrors, HistoryCursorExpired],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.get(
    "attempts",
    "/v1/projects/:projectId/delivery-operations/:operationId/attempts",
    {
      params: { projectId: Schema.String, operationId: Schema.String },
      query: HistoryQuery,
      success: AttemptPage,
      error: [...commonErrors, notFound, HistoryCursorExpired],
    },
  )
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.get("attempt", "/v1/projects/:projectId/attempts/:attemptId", {
    params: { projectId: Schema.String, attemptId: Schema.String },
    success: AttemptSnapshot,
    error: [...commonErrors, notFound],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.get("operations", "/v1/projects/:projectId/delivery-operations", {
    params: { projectId: Schema.String },
    query: HistoryQuery,
    success: OperationPage,
    error: [...commonErrors, HistoryCursorExpired],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
);
const ApplicationGroup = HttpApiGroup.make("application").add(
  HttpApiEndpoint.post("prepareDelivery", "/v1/projects/:projectId/delivery-operations", {
    params: { projectId: Schema.String },
    headers: MutationHeaders,
    payload: PrepareInput,
    success: DeliverySnapshot.pipe(HttpApiSchema.status(201)),
    error: [...commonErrors, notFound, conflict, unavailable, tooLarge, unprocessable, rateLimit],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.post("createDelivery", "/v1/projects/:projectId/delivery-operations/with-code", {
    params: { projectId: Schema.String },
    headers: MutationHeaders,
    payload: ExternalCreateInput,
    success: DeliverySnapshot.pipe(HttpApiSchema.status(201)),
    error: [...commonErrors, notFound, conflict, unavailable, tooLarge, unprocessable, rateLimit],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.get("getDelivery", "/v1/projects/:projectId/delivery-operations/:operationId", {
    params: { projectId: Schema.String, operationId: Schema.String },
    success: DeliverySnapshot,
    error: [...commonErrors, notFound, conflict, unavailable, tooLarge, unprocessable, rateLimit],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.post(
    "submitDeliveryCode",
    "/v1/projects/:projectId/delivery-operations/:operationId/code",
    {
      params: { projectId: Schema.String, operationId: Schema.String },
      headers: MutationHeaders,
      payload: SubmitInput,
      success: [DeliverySnapshot, DeliverySnapshot.pipe(HttpApiSchema.status(202))],
      error: [...commonErrors, notFound, conflict, unavailable, tooLarge, unprocessable, rateLimit],
    },
  )
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.post(
    "sendDelivery",
    "/v1/projects/:projectId/delivery-operations/:operationId/deliveries",
    {
      params: { projectId: Schema.String, operationId: Schema.String },
      headers: MutationHeaders,
      payload: DeliveryInput,
      success: DeliverySnapshot.pipe(HttpApiSchema.status(202)),
      error: [...commonErrors, notFound, conflict, unavailable, tooLarge, unprocessable, rateLimit],
    },
  )
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.post(
    "closeDelivery",
    "/v1/projects/:projectId/delivery-operations/:operationId/close",
    {
      params: { projectId: Schema.String, operationId: Schema.String },
      headers: MutationHeaders,
      payload: Schema.Struct({}),
      success: DeliverySnapshot,
      error: [...commonErrors, notFound, conflict, unavailable, tooLarge, unprocessable, rateLimit],
    },
  )
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.post("createChallenge", "/v1/projects/:projectId/challenges", {
    params: { projectId: Schema.String },
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
  HttpApiEndpoint.get("getChallengeStatus", "/v1/projects/:projectId/challenges/:challengeId", {
    params,
    success: Snapshot,
    error: [...commonErrors, notFound],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth)
    .annotateMerge(OpenApi.annotations({ summary: "Read the current challenge snapshot" })),
  HttpApiEndpoint.post(
    "verifyChallenge",
    "/v1/projects/:projectId/challenges/:challengeId/verify",
    {
      params,
      headers: MutationHeaders,
      payload: VerifyInput,
      success: VerificationResult,
      error: [...commonErrors, notFound, conflict, unavailable, tooLarge, unprocessable, rateLimit],
    },
  )
    .middleware(RequestValidation)
    .middleware(ApplicationAuth)
    .annotateMerge(OpenApi.annotations({ summary: "Verify a challenge" })),
  HttpApiEndpoint.post(
    "scheduleDelivery",
    "/v1/projects/:projectId/challenges/:challengeId/deliveries",
    {
      params,
      headers: MutationHeaders,
      payload: DeliveryInput,
      success: DeliveryResult.pipe(HttpApiSchema.status(202)),
      error: [...commonErrors, notFound, conflict, unavailable, tooLarge, unprocessable, rateLimit],
    },
  )
    .middleware(RequestValidation)
    .middleware(ApplicationAuth)
    .annotateMerge(
      OpenApi.annotations({ summary: "Queue a resend, next route, or manual selection" }),
    ),
  HttpApiEndpoint.post(
    "cancelChallenge",
    "/v1/projects/:projectId/challenges/:challengeId/cancel",
    {
      params,
      headers: MutationHeaders,
      payload: Schema.Struct({}),
      success: Snapshot,
      error: [...commonErrors, notFound, conflict, tooLarge],
    },
  )
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
  .add(ApplicationGroup, HistoryGroup, WebhookGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "OTP Router API",
      version: "1.0.0",
      description: "Backend challenge operations and provider callback ingress.",
    }),
  );
const makeOpenApiDocument = () => ({
  ...OpenApi.fromApi(OtpRouterApi),
  webhooks: Object.fromEntries(
    Object.entries({
      "challenge.updated": Schema.toJsonSchemaDocument(ChallengeEvent),
      "delivery.updated": Schema.toJsonSchemaDocument(DeliveryEvent),
      "attempt.updated": Schema.toJsonSchemaDocument(AttemptEvent),
      "attempt.evidence": Schema.toJsonSchemaDocument(EvidenceEvent),
    }).map(([kind, eventSchema]) => [
      kind,
      {
        post: {
          summary: "An immutable snapshot delivered at least once; events may arrive out of order",
          security: [],
          parameters: ["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => ({
            name,
            in: "header",
            required: true,
            schema: { type: "string" },
          })),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { ...eventSchema.schema, $defs: eventSchema.definitions },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Receiver durably recorded the authenticated event (any 2xx acknowledges receipt)",
            },
          },
        },
      },
    ]),
  ),
});

export const openApiDocument = /* @__PURE__ */ makeOpenApiDocument();

export { ErrorBody, UnauthorizedError } from "./responses.js";

export { DeliveryInput } from "@otp-router/engine/challenges";
