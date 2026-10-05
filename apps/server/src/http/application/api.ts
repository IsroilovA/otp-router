import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import {
  PrepareInput,
  CreateInput as ExternalCreateInput,
  SubmitInput,
  Snapshot as DeliverySnapshot,
} from "@otp-router/engine/delivery";
import {
  CreateInput,
  DeliveryInput,
  DeliveryResult,
  Snapshot,
  VerificationResult,
  VerifyInput,
} from "@otp-router/engine/challenges";
import {
  ApplicationAuth,
  RequestValidation,
  MutationHeaders,
  commonErrors,
  conflict,
  notFound,
  unavailable,
  tooLarge,
  unprocessable,
  rateLimit,
} from "../contracts.js";

const params = { projectId: Schema.String, challengeId: Schema.String };
export const ApplicationGroup = HttpApiGroup.make("application").add(
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
