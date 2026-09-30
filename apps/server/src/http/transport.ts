import { randomUUID } from "node:crypto";
import { type Context, Effect, Layer, Schema } from "effect";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/unstable/httpapi";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { RuntimeAdministration } from "@otp-router/engine/runtime";
import { Projects } from "@otp-router/engine/projects";
import { Delivery } from "@otp-router/engine/delivery";
import { DeliveryHistory } from "@otp-router/engine/history";
import { Router } from "@otp-router/engine/challenges";
import { Principals } from "../config/config.js";
import { OtpRouterApi } from "./api.js";
import { RequestValidation } from "./contracts.js";
import { errorResponse } from "./errors.js";
import { makeAuthLayer, makeAdminAuth } from "./authentication.js";
import { makeApplicationHandlers } from "./application/handlers.js";
import { makeHistoryHandlers } from "./history/handlers.js";
import { makeAdminHandlers } from "./projects/handlers.js";
import { makeRuntimeHandlers } from "./runtime/handlers.js";
import { makeWebhookHandlers } from "./callbacks/handlers.js";
import { WebhookHandler } from "./callbacks/contracts.js";

const DEFAULT_WEBHOOK_BODY_LIMIT = 256 * 1024;

export interface HttpTransportOptions {
  readonly principals: typeof Principals.Type;
  readonly administrators: typeof Principals.Type;
  readonly webhookBodyLimitBytes?: number;
}

export interface HttpDependencies {
  readonly runtime: Context.Service.Shape<typeof RuntimeAdministration>;
  readonly projects: Context.Service.Shape<typeof Projects>;
  readonly router: Context.Service.Shape<typeof Router>;
  readonly delivery: Context.Service.Shape<typeof Delivery>;
  readonly history: Context.Service.Shape<typeof DeliveryHistory>;
  readonly webhooks: Context.Service.Shape<typeof WebhookHandler>;
}
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
    Layer.merge(makeAdminHandlers, makeRuntimeHandlers).pipe(
      Layer.provide(makeAdminAuth(options.administrators)),
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
        Layer.succeed(Projects, dependencies.projects),
        Layer.succeed(RuntimeAdministration, dependencies.runtime),
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
