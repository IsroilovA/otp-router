import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { OtpRouterApi } from "../api.js";
import { BodyTooLarge, readBody } from "../body.js";
import {
  WebhookHandler,
  statusForWebhookError,
  type WebhookError,
  type WebhookQuery,
} from "./contracts.js";

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
export const makeWebhookHandlers = (bodyLimit: number) =>
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
