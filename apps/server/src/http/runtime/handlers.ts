import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerResponse } from "effect/unstable/http";
import { RuntimeAdministration, RuntimeCommand } from "@otp-router/engine/runtime";
import { OtpRouterApi } from "../api.js";
import { AdminContext } from "../contracts.js";
import { errorResponse } from "../errors.js";
import { readApplicationJson, transportFailure } from "../body.js";
import { adminRead } from "../admin-response.js";

export const makeRuntimeHandlers = HttpApiBuilder.group(
  OtpRouterApi,
  "runtimeAdministration",
  (handlers) =>
    handlers
      .handleRaw("mutate", ({ request, headers }) =>
        Effect.gen(function* () {
          const { actorId, requestId } = yield* AdminContext;
          const runtime = yield* RuntimeAdministration;
          const command = yield* readApplicationJson(
            request,
            Schema.Struct({ command: RuntimeCommand }),
          ).pipe(Effect.catch((error) => transportFailure(error, requestId)));
          if (HttpServerResponse.isHttpServerResponse(command)) return command;
          return yield* runtime
            .mutate({ actorId, key: headers["idempotency-key"], command: command.command })
            .pipe(
              Effect.map((result) =>
                HttpServerResponse.jsonUnsafe(result.body, {
                  headers: {
                    etag: `"${result.body.revision}"`,
                    "x-request-id": requestId,
                    ...(result.replayed ? { "idempotency-replayed": "true" } : {}),
                  },
                }),
              ),
              Effect.catchTag("DomainError", (error) => errorResponse(error.code, requestId)),
            );
        }),
      )
      .handleRaw("get", ({ params }) =>
        Effect.gen(function* () {
          const runtime = yield* RuntimeAdministration;
          const { actorId } = yield* AdminContext;
          return yield* adminRead(runtime.get(actorId, params.kind, params.id));
        }),
      )
      .handleRaw("list", ({ params, query }) =>
        Effect.gen(function* () {
          const runtime = yield* RuntimeAdministration;
          const { actorId } = yield* AdminContext;
          return yield* adminRead(runtime.list(actorId, params.kind, query));
        }),
      )
      .handleRaw("assignments", ({ params }) =>
        Effect.gen(function* () {
          const runtime = yield* RuntimeAdministration;
          const { actorId } = yield* AdminContext;
          return yield* adminRead(runtime.assignments(actorId, params.projectId));
        }),
      )
      .handleRaw("audit", ({ params, query }) =>
        Effect.gen(function* () {
          const runtime = yield* RuntimeAdministration;
          const { actorId } = yield* AdminContext;
          return yield* adminRead(runtime.audit(actorId, params.kind, params.id, query));
        }),
      ),
);
