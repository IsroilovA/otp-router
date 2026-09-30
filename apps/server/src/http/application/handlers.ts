import { Cause, Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  Delivery,
  PrepareInput,
  CreateInput as ExternalCreateInput,
  SubmitInput,
  type OperationResult as ExternalResult,
} from "@otp-router/engine/delivery";
import {
  Router,
  CreateInput as CreateInputSchema,
  DeliveryInput as DeliveryInputSchema,
  VerifyInput as VerifyInputSchema,
  type DomainError,
  type Mutation,
  type OperationResult,
} from "@otp-router/engine/challenges";
import { OtpRouterApi } from "../api.js";
import { RequestContext } from "../contracts.js";
import { errorResponse, responseHeaders } from "../errors.js";
import {
  statusForOutcome,
  type ErrorCode,
  ResponseBody as ResponseBodySchema,
} from "../responses.js";
import { readApplicationJson, transportFailure } from "../body.js";

const operationResponse = (result: OperationResult | ExternalResult) =>
  Schema.encodeEffect(ResponseBodySchema)(
    result.outcome === "incorrect_code"
      ? { error: { ...result.body.error, message: "The code is incorrect." } }
      : result.body,
  ).pipe(
    Effect.map((body) =>
      HttpServerResponse.jsonUnsafe(body, {
        status: statusForOutcome(result.outcome),
        headers: responseHeaders(result.replayed, body),
      }),
    ),
  );
const complete = (
  effect: Effect.Effect<
    OperationResult | ExternalResult,
    { readonly _tag: "DomainError"; readonly code: ErrorCode; readonly retryAt?: string }
  >,
  requestId: string,
) =>
  effect.pipe(
    Effect.flatMap(operationResponse),
    Effect.catchTag("DomainError", (error) => errorResponse(error.code, requestId, error.retryAt)),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logError("http_request_failed").pipe(
            Effect.annotateLogs({
              requestId,
              reason: "internal_error",
            }),
            Effect.andThen(errorResponse("internal_error", requestId)),
          ),
    ),
  );
const completeMutation = <A, I>(
  request: HttpServerRequest.HttpServerRequest,
  headers: { readonly "idempotency-key": string },
  schema: Schema.Codec<A, I>,
  run: (mutation: Mutation<A>) => Effect.Effect<OperationResult | ExternalResult, DomainError>,
) =>
  Effect.gen(function* () {
    const { requestId, projectId, principalId } = yield* RequestContext;
    const input = yield* readApplicationJson(request, schema).pipe(
      Effect.catch((error) => transportFailure(error, requestId)),
    );
    if (HttpServerResponse.isHttpServerResponse(input)) return input;
    return yield* complete(
      run({ principalId, projectId, key: headers["idempotency-key"], input, requestId }),
      requestId,
    );
  });
export const makeApplicationHandlers = HttpApiBuilder.group(
  OtpRouterApi,
  "application",
  (handlers) =>
    handlers
      .handleRaw("prepareDelivery", ({ request, headers }) =>
        Effect.gen(function* () {
          const delivery = yield* Delivery;
          return yield* completeMutation(request, headers, PrepareInput, (mutation) =>
            delivery.prepare(mutation),
          );
        }),
      )
      .handleRaw("createDelivery", ({ request, headers }) =>
        Effect.gen(function* () {
          const delivery = yield* Delivery;
          return yield* completeMutation(request, headers, ExternalCreateInput, (mutation) =>
            delivery.create(mutation),
          );
        }),
      )
      .handleRaw("submitDeliveryCode", ({ request, headers, params: path }) =>
        Effect.gen(function* () {
          const delivery = yield* Delivery;
          return yield* completeMutation(request, headers, SubmitInput, (mutation) =>
            delivery.submitCode({ ...mutation, operationId: path.operationId }),
          );
        }),
      )
      .handleRaw("sendDelivery", ({ request, headers, params: path }) =>
        Effect.gen(function* () {
          const delivery = yield* Delivery;
          return yield* completeMutation(request, headers, DeliveryInputSchema, (mutation) =>
            delivery.deliver({ ...mutation, operationId: path.operationId }),
          );
        }),
      )
      .handleRaw("closeDelivery", ({ request, headers, params: path }) =>
        Effect.gen(function* () {
          const delivery = yield* Delivery;
          return yield* completeMutation(request, headers, Schema.Struct({}), (mutation) =>
            delivery.close({ ...mutation, operationId: path.operationId }),
          );
        }),
      )
      .handleRaw("getDelivery", ({ params: path }) =>
        Effect.gen(function* () {
          const { requestId, projectId, principalId } = yield* RequestContext;
          const delivery = yield* Delivery;
          return yield* complete(
            delivery.status(projectId, path.operationId, principalId),
            requestId,
          );
        }),
      )
      .handleRaw("createChallenge", ({ request, headers }) =>
        Effect.gen(function* () {
          const router = yield* Router;
          return yield* completeMutation(request, headers, CreateInputSchema, (mutation) =>
            router.create(mutation),
          );
        }),
      )
      .handleRaw("getChallengeStatus", ({ params: path }) =>
        Effect.gen(function* () {
          const { requestId, projectId, principalId } = yield* RequestContext;
          const router = yield* Router;
          return yield* complete(
            router.status(projectId, path.challengeId, principalId),
            requestId,
          );
        }),
      )
      .handleRaw("verifyChallenge", ({ params: path, request, headers }) =>
        Effect.gen(function* () {
          const router = yield* Router;
          return yield* completeMutation(request, headers, VerifyInputSchema, (mutation) =>
            router.verify({ ...mutation, challengeId: path.challengeId }),
          );
        }),
      )
      .handleRaw("scheduleDelivery", ({ params: path, request, headers }) =>
        Effect.gen(function* () {
          const router = yield* Router;
          return yield* completeMutation(request, headers, DeliveryInputSchema, (mutation) =>
            router.deliver({ ...mutation, challengeId: path.challengeId }),
          );
        }),
      )
      .handleRaw("cancelChallenge", ({ params: path, request, headers }) =>
        Effect.gen(function* () {
          const router = yield* Router;
          return yield* completeMutation(request, headers, Schema.Struct({}), (mutation) =>
            router.cancel({ ...mutation, challengeId: path.challengeId }),
          );
        }),
      ),
);
