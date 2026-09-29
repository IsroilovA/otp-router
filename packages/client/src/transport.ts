import { ErrorBody, OtpRouterApi } from "@otp-router/server/api";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import type {
  AdminClientOptions,
  ClientResponse,
  RequestOptions,
  ResponseMetadata,
} from "./contracts.js";
import { OtpRouterApiError, OtpRouterClientError } from "./errors.js";

type GeneratedClient = HttpApiClient.ForApi<typeof OtpRouterApi, never, HttpClient.HttpClient>;
const Timeout = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }));
const Configuration = Schema.Struct({
  bearerToken: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]+$/u)),
});
const metadata = (response: HttpClientResponse.HttpClientResponse): ResponseMetadata => ({
  status: response.status,
  etag: response.headers["etag"] ?? null,
  requestId: response.headers["x-request-id"] ?? null,
  replayed: response.headers["idempotency-replayed"] === "true",
  retryAfter: response.headers["retry-after"] ?? null,
});

const baseUrl = (input: string | URL): string => {
  try {
    const url = new URL(input);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new OtpRouterClientError("configuration");
    }
    return url.href.replace(/\/+$/u, "");
  } catch {
    throw new OtpRouterClientError("configuration");
  }
};

export const makeTransport = (options: AdminClientOptions) => {
  const url = baseUrl(options.baseUrl);
  if (!Schema.is(Configuration)(options) || !Schema.is(Timeout)(options.timeoutMs ?? 30_000)) {
    throw new OtpRouterClientError("configuration");
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const fetch = options.fetch ?? globalThis.fetch;
  // Compile endpoint codecs once; resolve the HTTP transport in each request's context.
  const generated = Effect.runSync(
    HttpApiClient.makeWith(OtpRouterApi, {
      baseUrl: url,
      httpClient: HttpClient.makeWith(
        (request: Effect.Effect<HttpClientRequest.HttpClientRequest>) =>
          Effect.flatMap(request, HttpClient.execute),
        Effect.succeed,
      ),
    }),
  );
  return async <A, E>(
    action: (
      client: GeneratedClient,
    ) => Effect.Effect<
      readonly [A, HttpClientResponse.HttpClientResponse],
      E,
      HttpClient.HttpClient
    >,
    request: RequestOptions,
  ): Promise<ClientResponse<A>> => {
    const duration = request.timeoutMs ?? timeoutMs;
    if (!Schema.is(Timeout)(duration)) throw new OtpRouterClientError("configuration");
    const timeout = AbortSignal.timeout(duration);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
    if (signal.aborted) throw new OtpRouterClientError("aborted");
    let response: ResponseMetadata | undefined;
    const program = Effect.flatMap(HttpClient.HttpClient, (client) =>
      action(generated).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          client.pipe(
            HttpClient.mapRequest(
              HttpClientRequest.setHeader("authorization", `Bearer ${options.bearerToken}`),
            ),
            HttpClient.transformResponse(
              Effect.tap((value) =>
                Effect.sync(() => {
                  response = metadata(value);
                }),
              ),
            ),
          ),
        ),
      ),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", cache: "no-store" }),
    );
    const exit = await Effect.runPromiseExit(program, { signal });
    if (Exit.isSuccess(exit)) {
      const [data, raw] = exit.value;
      return { data, ...metadata(raw) };
    }
    if (request.signal?.aborted === true) throw new OtpRouterClientError("aborted", response);
    if (timeout.aborted) throw new OtpRouterClientError("timeout", response);
    const failure = Cause.findErrorOption(exit.cause);
    if (Option.isNone(failure)) throw new OtpRouterClientError("defect", response);
    if (Schema.is(ErrorBody)(failure.value) && response !== undefined) {
      throw new OtpRouterApiError(failure.value.error, response);
    }
    if (response !== undefined) throw new OtpRouterClientError("invalid_response", response);
    if (Schema.isSchemaError(failure.value)) throw new OtpRouterClientError("invalid_request");
    throw new OtpRouterClientError("transport");
  };
};
