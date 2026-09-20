import { logEvent } from "../diagnostics/log.js";
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
  type ErrorCode,
  type OperationResult,
  type ErrorBody as ErrorBodySchema,
  ResponseBody as ResponseBodySchema,
  Router,
  VerifyInput as VerifyInputSchema,
  statusForError,
} from "../challenges/contracts.js";
import { ApplicationAuth, OtpRouterApi, RequestContext, RequestValidation } from "./api.js";
import { decodeJson } from "./json.js";
import {
  type WebhookError,
  WebhookHandler,
  type WebhookQuery,
  statusForWebhookError,
} from "./webhooks.js";

const APPLICATION_BODY_LIMIT = 16 * 1024;
const DEFAULT_WEBHOOK_BODY_LIMIT = 256 * 1024;

export interface HttpTransportOptions {
  readonly apiKeys: ReadonlyArray<string>;
  readonly webhookBodyLimitBytes?: number;
}

export interface HttpDependencies {
  readonly router: Context.Service.Shape<typeof Router>;
  readonly webhooks: Context.Service.Shape<typeof WebhookHandler>;
}

class BodyTooLarge extends Data.TaggedError("BodyTooLarge") {}
class InvalidRequest extends Data.TaggedError("InvalidRequest") {}

interface BodyState {
  readonly size: number;
  readonly chunks: ReadonlyArray<Uint8Array>;
}

const initialBodyState: BodyState = { size: 0, chunks: [] };

const readBody = (
  request: HttpServerRequest.HttpServerRequest,
  limit: number,
): Effect.Effect<Uint8Array, BodyTooLarge | InvalidRequest> =>
  request.stream.pipe(
    Stream.runFoldEffect<BodyState, Uint8Array, BodyTooLarge, never>(
      () => initialBodyState,
      (state, chunk) => {
        const size = state.size + chunk.byteLength;
        if (size > limit) return Effect.fail(new BodyTooLarge());
        return Effect.succeed({ size, chunks: [...state.chunks, chunk] });
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

const operationResponse = (result: OperationResult) =>
  Schema.encodeEffect(ResponseBodySchema)(result.body).pipe(
    Effect.map((body) =>
      HttpServerResponse.jsonUnsafe(body, {
        status: result.status,
        headers: responseHeaders(result.replayed, result.body),
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
    OperationResult,
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
        : logEvent({
            event: "application_operation",
            outcome: "defect",
            reason: "internal_error",
            requestId,
          }).pipe(Effect.andThen(errorResponse("internal_error", requestId))),
    ),
  );

const transportFailure = (error: BodyTooLarge | InvalidRequest, requestId: string) =>
  errorResponse(error instanceof BodyTooLarge ? "request_too_large" : "invalid_request", requestId);

const mutationInput = <A, I>(
  request: HttpServerRequest.HttpServerRequest,
  headers: { readonly "idempotency-key": string },
  schema: Schema.Codec<A, I>,
) =>
  Effect.all({
    key: Effect.succeed(headers["idempotency-key"]),
    input: readApplicationJson(request, schema),
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

const makeAuthLayer = (apiKeys: ReadonlyArray<string>) => {
  const expected = apiKeys.map(digest);
  return Layer.succeed(ApplicationAuth, {
    bearer: (httpEffect, { credential }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers["authorization"] ?? "";
        const token = Redacted.value(credential);
        const supplied = digest(token);
        let matched = false;
        for (const candidate of expected) matched = timingSafeEqual(supplied, candidate) || matched;
        const requestId = randomUUID();
        if (
          !authorization.startsWith("Bearer ") ||
          authorization.length !== token.length + 7 ||
          !matched
        )
          return yield* Effect.fail({
            error: {
              code: "unauthorized" as const,
              message: errorMessages.unauthorized,
              requestId,
            },
          });
        return yield* Effect.provideService(httpEffect, RequestContext, { requestId });
      }),
  });
};

const makeApplicationHandlers = HttpApiBuilder.group(OtpRouterApi, "application", (handlers) =>
  handlers
    .handleRaw("createChallenge", ({ request, headers }) =>
      Effect.gen(function* () {
        const { requestId } = yield* RequestContext;
        const router = yield* Router;
        const parsed = yield* mutationInput(request, headers, CreateInputSchema).pipe(
          Effect.catch((error) => transportFailure(error, requestId)),
        );
        if (HttpServerResponse.isHttpServerResponse(parsed)) return parsed;
        return yield* complete(router.create({ ...parsed, requestId }), requestId);
      }),
    )
    .handleRaw("getChallengeStatus", ({ params: path }) =>
      Effect.gen(function* () {
        const { requestId } = yield* RequestContext;
        const router = yield* Router;
        return yield* complete(router.status(path.challengeId), requestId);
      }),
    )
    .handleRaw("verifyChallenge", ({ params: path, request, headers }) =>
      Effect.gen(function* () {
        const { requestId } = yield* RequestContext;
        const router = yield* Router;
        const parsed = yield* mutationInput(request, headers, VerifyInputSchema).pipe(
          Effect.catch((error) => transportFailure(error, requestId)),
        );
        if (HttpServerResponse.isHttpServerResponse(parsed)) return parsed;
        return yield* complete(
          router.verify({ ...parsed, challengeId: path.challengeId, requestId }),
          requestId,
        );
      }),
    )
    .handleRaw("scheduleDelivery", ({ params: path, request, headers }) =>
      Effect.gen(function* () {
        const { requestId } = yield* RequestContext;
        const router = yield* Router;
        const parsed = yield* mutationInput(request, headers, DeliveryInputSchema).pipe(
          Effect.catch((error) => transportFailure(error, requestId)),
        );
        if (HttpServerResponse.isHttpServerResponse(parsed)) return parsed;
        return yield* complete(
          router.deliver({ ...parsed, challengeId: path.challengeId, requestId }),
          requestId,
        );
      }),
    )
    .handleRaw("cancelChallenge", ({ params: path, request, headers }) =>
      Effect.gen(function* () {
        const { requestId } = yield* RequestContext;
        const router = yield* Router;
        const parsed = yield* mutationInput(request, headers, Schema.Struct({})).pipe(
          Effect.catch((error) => transportFailure(error, requestId)),
        );
        if (HttpServerResponse.isHttpServerResponse(parsed)) return parsed;
        return yield* complete(
          router.cancel({ ...parsed, challengeId: path.challengeId, requestId }),
          requestId,
        );
      }),
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
  if (options.apiKeys.length < 1 || options.apiKeys.length > 2) {
    throw new RangeError("apiKeys must contain one or two keys");
  }
  if (options.apiKeys.some((key) => Buffer.byteLength(key, "utf8") < 32)) {
    throw new RangeError("apiKeys must contain at least 32 bytes");
  }
  const webhookBodyLimit = options.webhookBodyLimitBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT;
  if (!Number.isSafeInteger(webhookBodyLimit) || webhookBodyLimit <= 0) {
    throw new RangeError("webhookBodyLimitBytes must be a positive safe integer");
  }
  const auth = makeAuthLayer(options.apiKeys);
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
      Layer.merge(
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
