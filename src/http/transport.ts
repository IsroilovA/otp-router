import { logEvent } from "../diagnostics/log.js";
import {
  type HttpApi,
  HttpApiBuilder,
  type HttpApp,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Cause, type Context, Data, Effect, Layer, Redacted, Schema, Stream } from "effect";
import {
  CreateInput as CreateInputSchema,
  DeliveryInput as DeliveryInputSchema,
  type ErrorCode,
  type OperationResult,
  Opaque,
  type ErrorBody as ErrorBodySchema,
  ResponseBody as ResponseBodySchema,
  Router,
  VerifyInput as VerifyInputSchema,
  statusForError,
} from "../challenges/contracts.js";
import { ApplicationAuth, OtpRouterApi, RequestContext } from "./api.js";
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
  readonly router: Context.Tag.Service<typeof Router>;
  readonly webhooks: Context.Tag.Service<typeof WebhookHandler>;
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
      initialBodyState,
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
  schema: Schema.Schema<A, I>,
): Effect.Effect<A, BodyTooLarge | InvalidRequest> =>
  validateApplicationHeaders(request).pipe(
    Effect.zipRight(readBody(request, APPLICATION_BODY_LIMIT)),
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
    ...(code === "incorrect_code" ? { verificationState: "active" as const } : {}),
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
  Schema.encode(ResponseBodySchema)(result.body).pipe(
    Effect.map((body) =>
      HttpServerResponse.unsafeJson(body, {
        status: result.status,
        headers: responseHeaders(result.replayed, result.body),
      }),
    ),
  );

const errorResponse = (code: ErrorCode, requestId: string, retryAt?: string) => {
  const body = makeErrorBody(code, requestId, retryAt);
  return HttpServerResponse.unsafeJson(body, {
    status: statusForError(code),
    headers: responseHeaders(false, body),
  });
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
    Effect.catchAllCause((cause) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.interrupt
        : logEvent({
            event: "application_operation",
            outcome: "defect",
            reason: "internal_error",
            requestId,
          }).pipe(Effect.zipRight(errorResponse("internal_error", requestId))),
    ),
  );

const requireIdempotencyKey = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<string, InvalidRequest> => {
  const key = request.headers["idempotency-key"];
  if (key === undefined) return Effect.fail(new InvalidRequest());
  return Schema.decodeUnknown(Opaque)(key).pipe(Effect.mapError(() => new InvalidRequest()));
};

const transportFailure = (error: BodyTooLarge | InvalidRequest, requestId: string) =>
  errorResponse(error instanceof BodyTooLarge ? "request_too_large" : "invalid_request", requestId);

const mutationInput = <A, I>(
  request: HttpServerRequest.HttpServerRequest,
  schema: Schema.Schema<A, I>,
) =>
  Effect.all({
    key: requireIdempotencyKey(request),
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
    bearer: (redacted) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers["authorization"] ?? "";
        const token = Redacted.value(redacted);
        const supplied = digest(token);
        let matched = false;
        for (const candidate of expected) matched = timingSafeEqual(supplied, candidate) || matched;
        return {
          authorized:
            authorization.startsWith("Bearer ") &&
            authorization.length === token.length + 7 &&
            matched,
          requestId: randomUUID(),
        };
      }),
  });
};

const makeApplicationHandlers = HttpApiBuilder.group(OtpRouterApi, "application", (handlers) =>
  handlers
    .handleRaw("createChallenge", ({ request }) =>
      Effect.gen(function* () {
        const { authorized, requestId } = yield* RequestContext;
        if (!authorized) return errorResponse("unauthorized", requestId);
        const router = yield* Router;
        const parsed = yield* mutationInput(request, CreateInputSchema).pipe(
          Effect.catchAll((error) => transportFailure(error, requestId)),
        );
        if (HttpServerResponse.isServerResponse(parsed)) return parsed;
        return yield* complete(router.create({ ...parsed, requestId }), requestId);
      }),
    )
    .handleRaw("getChallengeStatus", ({ path }) =>
      Effect.gen(function* () {
        const { authorized, requestId } = yield* RequestContext;
        if (!authorized) return errorResponse("unauthorized", requestId);
        const router = yield* Router;
        return yield* complete(router.status(path.challengeId), requestId);
      }),
    )
    .handleRaw("verifyChallenge", ({ path, request }) =>
      Effect.gen(function* () {
        const { authorized, requestId } = yield* RequestContext;
        if (!authorized) return errorResponse("unauthorized", requestId);
        const router = yield* Router;
        const parsed = yield* mutationInput(request, VerifyInputSchema).pipe(
          Effect.catchAll((error) => transportFailure(error, requestId)),
        );
        if (HttpServerResponse.isServerResponse(parsed)) return parsed;
        return yield* complete(
          router.verify({ ...parsed, challengeId: path.challengeId, requestId }),
          requestId,
        );
      }),
    )
    .handleRaw("scheduleDelivery", ({ path, request }) =>
      Effect.gen(function* () {
        const { authorized, requestId } = yield* RequestContext;
        if (!authorized) return errorResponse("unauthorized", requestId);
        const router = yield* Router;
        const parsed = yield* mutationInput(request, DeliveryInputSchema).pipe(
          Effect.catchAll((error) => transportFailure(error, requestId)),
        );
        if (HttpServerResponse.isServerResponse(parsed)) return parsed;
        return yield* complete(
          router.deliver({ ...parsed, challengeId: path.challengeId, requestId }),
          requestId,
        );
      }),
    )
    .handleRaw("cancelChallenge", ({ path, request }) =>
      Effect.gen(function* () {
        const { authorized, requestId } = yield* RequestContext;
        if (!authorized) return errorResponse("unauthorized", requestId);
        const router = yield* Router;
        const parsed = yield* mutationInput(request, Schema.Struct({})).pipe(
          Effect.catchAll((error) => transportFailure(error, requestId)),
        );
        if (HttpServerResponse.isServerResponse(parsed)) return parsed;
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
      .handleRaw("providerHandshake", ({ path, request }) =>
        Effect.gen(function* () {
          const webhooks = yield* WebhookHandler;
          const reply = yield* webhooks
            .handshake({
              providerInstanceId: path.providerInstanceId,
              headers: request.headers,
              query: queryFromRequest(request),
            })
            .pipe(Effect.catchAll(webhookFailureResponse));
          if (HttpServerResponse.isServerResponse(reply)) return reply;
          return HttpServerResponse.text(reply.body, {
            status: 200,
            contentType: reply.contentType ?? "text/plain; charset=utf-8",
          });
        }),
      )
      .handleRaw("providerCallback", ({ path, request }) =>
        Effect.gen(function* () {
          const webhooks = yield* WebhookHandler;
          const body = yield* readBody(request, bodyLimit).pipe(
            Effect.catchAll((error) =>
              Effect.succeed(
                HttpServerResponse.empty({
                  status: error instanceof BodyTooLarge ? 413 : 400,
                }),
              ),
            ),
          );
          if (HttpServerResponse.isServerResponse(body)) return body;
          const ingested = yield* webhooks
            .ingest({
              providerInstanceId: path.providerInstanceId,
              headers: request.headers,
              query: queryFromRequest(request),
              body,
            })
            .pipe(Effect.as(true), Effect.catchAll(webhookFailureResponse));
          if (HttpServerResponse.isServerResponse(ingested)) return ingested;
          return HttpServerResponse.empty({ status: 200 });
        }),
      ),
  );

export const makeHttpApiLayer = (
  options: HttpTransportOptions,
): Layer.Layer<HttpApi.Api, never, Router | WebhookHandler> => {
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
    makeApplicationHandlers.pipe(Layer.provide(auth)),
    makeWebhookHandlers(webhookBodyLimit),
    auth,
  );
  return HttpApiBuilder.api(OtpRouterApi).pipe(Layer.provide(handlers));
};

export const makeWebHandler = (options: HttpTransportOptions, dependencies: HttpDependencies) => {
  const api = makeHttpApiLayer(options).pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(Router, dependencies.router),
        Layer.succeed(WebhookHandler, dependencies.webhooks),
      ),
    ),
  );
  return HttpApiBuilder.toWebHandler(Layer.merge(api, HttpServer.layerContext), {
    middleware: httpResponseMiddleware,
  });
};

export const httpResponseMiddleware = <E, R>(app: HttpApp.Default<E, R>): HttpApp.Default<E, R> =>
  app.pipe(
    Effect.map((response) => HttpServerResponse.setHeader(response, "cache-control", "no-store")),
  );
