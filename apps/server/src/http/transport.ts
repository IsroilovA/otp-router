import {
  DeliveryHistory,
  Delivery,
  PrepareInput,
  CreateInput as ExternalCreateInput,
  SubmitInput,
  type OperationResult as ExternalResult,
} from "@otp-router/engine/delivery";
import {
  statusForError,
  statusForOutcome,
  type ErrorCode,
  type ErrorBody as ErrorBodySchema,
  ResponseBody as ResponseBodySchema,
} from "./responses.js";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/unstable/httpapi";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Cause, type Context, Data, Effect, Layer, Redacted, Schema, Stream } from "effect";
import {
  CreateInput as CreateInputSchema,
  DeliveryInput as DeliveryInputSchema,
  type DomainError,
  type Mutation,
  type OperationResult,
  Router,
  VerifyInput as VerifyInputSchema,
} from "@otp-router/engine/challenges";
import { ApplicationAuth, OtpRouterApi, RequestContext, RequestValidation } from "./api.js";
import { decodeJson } from "./json.js";
import {
  type WebhookError,
  WebhookHandler,
  type WebhookQuery,
  statusForWebhookError,
} from "./webhooks.js";

import { Principals } from "../config/config.js";

const APPLICATION_BODY_LIMIT = 16 * 1024;
const DEFAULT_WEBHOOK_BODY_LIMIT = 256 * 1024;

export interface HttpTransportOptions {
  readonly principals: typeof Principals.Type;
  readonly webhookBodyLimitBytes?: number;
}

export interface HttpDependencies {
  readonly router: Context.Service.Shape<typeof Router>;
  readonly delivery: Context.Service.Shape<typeof Delivery>;
  readonly history: Context.Service.Shape<typeof DeliveryHistory>;
  readonly webhooks: Context.Service.Shape<typeof WebhookHandler>;
}

class BodyTooLarge extends Data.TaggedError("BodyTooLarge") {}
class InvalidRequest extends Data.TaggedError("InvalidRequest") {}

interface BodyState {
  readonly size: number;
  readonly chunks: Array<Uint8Array>;
}

const readBody = (
  request: HttpServerRequest.HttpServerRequest,
  limit: number,
): Effect.Effect<Uint8Array, BodyTooLarge | InvalidRequest> =>
  request.stream.pipe(
    Stream.runFoldEffect<BodyState, Uint8Array, BodyTooLarge, never>(
      () => ({ size: 0, chunks: [] }),
      (state, chunk) => {
        const size = state.size + chunk.byteLength;
        if (size > limit) return Effect.fail(new BodyTooLarge());
        state.chunks.push(chunk);
        return Effect.succeed({ size, chunks: state.chunks });
      },
    ),
    Effect.map((state) => {
      const body = new Uint8Array(state.size);
      let offset = 0;
      for (const chunk of state.chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    }),
    Effect.mapError((error) => (error instanceof BodyTooLarge ? error : new InvalidRequest())),
  );

const mediaType = (request: HttpServerRequest.HttpServerRequest): string =>
  (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";

const validateApplicationHeaders = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<void, BodyTooLarge | InvalidRequest> => {
  const length = request.headers["content-length"];
  if (length !== undefined) {
    if (!/^[0-9]+$/.test(length)) return Effect.fail(new InvalidRequest());
    if (Number(length) > APPLICATION_BODY_LIMIT) return Effect.fail(new BodyTooLarge());
  }
  if (mediaType(request) !== "application/json") return Effect.fail(new InvalidRequest());
  const encoding = request.headers["content-encoding"]?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "identity") return Effect.fail(new InvalidRequest());
  return Effect.void;
};

const decodeUtf8 = (body: Uint8Array): Effect.Effect<string, InvalidRequest> =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
    catch: () => new InvalidRequest(),
  });

const readApplicationJson = <A, I>(
  request: HttpServerRequest.HttpServerRequest,
  schema: Schema.Codec<A, I>,
): Effect.Effect<A, BodyTooLarge | InvalidRequest> =>
  validateApplicationHeaders(request).pipe(
    Effect.andThen(readBody(request, APPLICATION_BODY_LIMIT)),
    Effect.flatMap(decodeUtf8),
    Effect.flatMap(decodeJson(schema)),
    Effect.mapError((error) => (error instanceof BodyTooLarge ? error : new InvalidRequest())),
  );

const errorMessages = {
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
  error: {
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

const responseHeaders = (replayed: boolean, body: ResponseBody): Record<string, string> => {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (replayed) headers["idempotency-replayed"] = "true";
  if ("error" in body && body.error.retryAt !== undefined) {
    const value = retryAfter(body.error.retryAt);
    if (value !== undefined) headers["retry-after"] = value;
  }
  return headers;
};

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

const errorResponse = (code: ErrorCode, requestId: string, retryAt?: string) => {
  const body = makeErrorBody(code, requestId, retryAt);
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(body, {
      status: statusForError(code),
      headers: responseHeaders(false, body),
    }),
  );
};

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

const transportFailure = (error: BodyTooLarge | InvalidRequest, requestId: string) =>
  errorResponse(error instanceof BodyTooLarge ? "request_too_large" : "invalid_request", requestId);

const completeMutation = <A, I>(
  request: HttpServerRequest.HttpServerRequest,
  headers: { readonly "idempotency-key": string },
  schema: Schema.Codec<A, I>,
  run: (mutation: Mutation<A>) => Effect.Effect<OperationResult | ExternalResult, DomainError>,
) =>
  Effect.gen(function* () {
    const { requestId, projectId } = yield* RequestContext;
    const input = yield* readApplicationJson(request, schema).pipe(
      Effect.catch((error) => transportFailure(error, requestId)),
    );
    if (HttpServerResponse.isHttpServerResponse(input)) return input;
    return yield* complete(
      run({ projectId, key: headers["idempotency-key"], input, requestId }),
      requestId,
    );
  });

const queryFromRequest = (request: HttpServerRequest.HttpServerRequest): WebhookQuery => {
  const url = new URL(request.url, "http://localhost");
  const query: Record<string, string | ReadonlyArray<string>> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return query;
};

const webhookFailureResponse = (error: WebhookError) =>
  Effect.succeed(HttpServerResponse.empty({ status: statusForWebhookError(error.code) }));

const digest = (key: string): Buffer => createHash("sha256").update(key, "utf8").digest();

const makeAuthLayer = (principals: typeof Principals.Type) => {
  const expected = principals.flatMap((principal) =>
    principal.keys.map((key) => ({ digest: digest(key), principal })),
  );
  return Layer.succeed(ApplicationAuth, {
    bearer: (httpEffect, { credential }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers["authorization"] ?? "";
        const token = Redacted.value(credential);
        const supplied = digest(token);
        const projectId = /^\/v1\/projects\/([a-zA-Z0-9_-]+)(?:\/|$)/u.exec(request.url)?.[1];
        let principal: (typeof Principals.Type)[number] | undefined;
        for (const candidate of expected)
          if (timingSafeEqual(supplied, candidate.digest)) principal = candidate.principal;
        const requestId = randomUUID();
        if (
          !authorization.startsWith("Bearer ") ||
          authorization.length !== token.length + 7 ||
          principal === undefined ||
          projectId === undefined ||
          !principal.projectIds.includes(projectId)
        )
          return yield* Effect.fail({
            error: {
              code: "unauthorized" as const,
              message: errorMessages.unauthorized,
              requestId,
            },
          });
        return yield* Effect.provideService(httpEffect, RequestContext, {
          requestId,
          projectId,
          principalId: principal.id,
        });
      }),
  });
};

const makeApplicationHandlers = HttpApiBuilder.group(OtpRouterApi, "application", (handlers) =>
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
        const { requestId, projectId } = yield* RequestContext;
        const delivery = yield* Delivery;
        return yield* complete(delivery.status(projectId, path.operationId), requestId);
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
        const { requestId, projectId } = yield* RequestContext;
        const router = yield* Router;
        return yield* complete(router.status(projectId, path.challengeId), requestId);
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

const historyResponse = <A>(effect: Effect.Effect<A, DomainError>) =>
  Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    return yield* effect.pipe(
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body)),
      Effect.catchTag("DomainError", (error) => errorResponse(error.code, requestId)),
    );
  });
const makeHistoryHandlers = HttpApiBuilder.group(OtpRouterApi, "history", (handlers) =>
  handlers
    .handleRaw("events", ({ params, query }) =>
      Effect.flatMap(DeliveryHistory, (history) =>
        historyResponse(history.events(params.projectId, query)),
      ),
    )
    .handleRaw("attempts", ({ params, query }) =>
      Effect.flatMap(DeliveryHistory, (history) =>
        historyResponse(history.attempts(params.projectId, params.operationId, query)),
      ),
    )
    .handleRaw("attempt", ({ params }) =>
      Effect.flatMap(DeliveryHistory, (history) =>
        historyResponse(history.attempt(params.projectId, params.attemptId)),
      ),
    )
    .handleRaw("operations", ({ params, query }) =>
      Effect.flatMap(DeliveryHistory, (history) =>
        historyResponse(history.operations(params.projectId, query)),
      ),
    ),
);
const makeWebhookHandlers = (bodyLimit: number) =>
  HttpApiBuilder.group(OtpRouterApi, "providerCallbacks", (handlers) =>
    handlers
      .handleRaw("providerHandshake", ({ params: path, request }) =>
        Effect.gen(function* () {
          const webhooks = yield* WebhookHandler;
          const reply = yield* webhooks
            .handshake({
              providerInstanceId: path.providerInstanceId,
              headers: request.headers,
              query: queryFromRequest(request),
            })
            .pipe(Effect.catch(webhookFailureResponse));
          if (HttpServerResponse.isHttpServerResponse(reply)) return reply;
          return HttpServerResponse.uint8Array(reply.body, {
            status: reply.status,
            contentType: reply.contentType,
          });
        }),
      )
      .handleRaw("providerCallback", ({ params: path, request }) =>
        Effect.gen(function* () {
          const webhooks = yield* WebhookHandler;
          const body = yield* readBody(request, bodyLimit).pipe(
            Effect.catch((error) =>
              Effect.succeed(
                HttpServerResponse.empty({
                  status: error instanceof BodyTooLarge ? 413 : 400,
                }),
              ),
            ),
          );
          if (HttpServerResponse.isHttpServerResponse(body)) return body;
          const ingested = yield* webhooks
            .ingest({
              providerInstanceId: path.providerInstanceId,
              headers: request.headers,
              query: queryFromRequest(request),
              body,
            })
            .pipe(Effect.as(true), Effect.catch(webhookFailureResponse));
          if (HttpServerResponse.isHttpServerResponse(ingested)) return ingested;
          return HttpServerResponse.empty({ status: 200 });
        }),
      ),
  );

export const makeHttpApiLayer = (options: HttpTransportOptions) => {
  const principals = Schema.decodeUnknownSync(Principals)(options.principals);
  const webhookBodyLimit = options.webhookBodyLimitBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT;
  if (!Number.isSafeInteger(webhookBodyLimit) || webhookBodyLimit <= 0) {
    throw new RangeError("webhookBodyLimitBytes must be a positive safe integer");
  }
  const auth = makeAuthLayer(principals);
  const handlers = Layer.mergeAll(
    makeApplicationHandlers.pipe(
      Layer.provide(
        Layer.merge(
          auth,
          HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (error) =>
            errorResponse(
              error.kind === "Body" || error.kind === "ResponseHeaders"
                ? "internal_error"
                : "invalid_request",
              randomUUID(),
            ),
          ),
        ),
      ),
    ),
    makeHistoryHandlers.pipe(
      Layer.provide(auth),
      Layer.provide(
        HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, () =>
          errorResponse("invalid_request", randomUUID()),
        ),
      ),
    ),
    makeWebhookHandlers(webhookBodyLimit),
    auth,
  );
  return HttpApiBuilder.layer(OtpRouterApi).pipe(
    Layer.provide(handlers),
    Layer.provide(HttpRouter.middleware(httpResponseMiddleware).layer),
  );
};

export const makeWebHandler = (options: HttpTransportOptions, dependencies: HttpDependencies) => {
  const api = makeHttpApiLayer(options).pipe(
    HttpRouter.provideRequest(
      Layer.mergeAll(
        Layer.succeed(Delivery, dependencies.delivery),
        Layer.succeed(DeliveryHistory, dependencies.history),
        Layer.succeed(Router, dependencies.router),
        Layer.succeed(WebhookHandler, dependencies.webhooks),
      ),
    ),
  );
  return HttpRouter.toWebHandler(api.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });
};

const httpResponseMiddleware = <E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  app.pipe(
    Effect.map((response) => HttpServerResponse.setHeader(response, "cache-control", "no-store")),
  );
