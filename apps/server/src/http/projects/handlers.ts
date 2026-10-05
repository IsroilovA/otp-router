import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  Projects,
  CreateProjectInput,
  ProjectSettings,
  type AdminCommand,
  type AdminResult,
} from "@otp-router/engine/projects";
import { OtpRouterApi } from "../api.js";
import { AdminContext } from "../contracts.js";
import { errorResponse } from "../errors.js";
import { readApplicationJson, transportFailure } from "../body.js";
import { adminRead } from "../admin-response.js";

const adminMutation = <A, I>(
  request: HttpServerRequest.HttpServerRequest,
  headers: { readonly "idempotency-key": string },
  schema: Schema.Codec<A, I>,
  command: (input: A) => typeof AdminCommand.Type,
) =>
  Effect.gen(function* () {
    const { actorId, requestId } = yield* AdminContext;
    const projects = yield* Projects;
    const input = yield* readApplicationJson(request, schema).pipe(
      Effect.catch((error) => transportFailure(error, requestId)),
    );
    if (HttpServerResponse.isHttpServerResponse(input)) return input;
    return yield* projects
      .mutate({ actorId, key: headers["idempotency-key"], command: command(input) })
      .pipe(
        Effect.map((result: typeof AdminResult.Type) =>
          HttpServerResponse.jsonUnsafe(result.body, {
            status: result.status,
            headers: {
              etag: `"${result.body.revision}"`,
              "x-request-id": requestId,
              ...(result.replayed ? { "idempotency-replayed": "true" } : {}),
            },
          }),
        ),
        Effect.catchTag("DomainError", (error) => errorResponse(error.code, requestId)),
      );
  });
export const makeAdminHandlers = HttpApiBuilder.group(OtpRouterApi, "administration", (handlers) =>
  handlers
    .handleRaw("createProject", ({ request, headers }) =>
      adminMutation(request, headers, CreateProjectInput, (input) => ({ action: "create", input })),
    )
    .handleRaw("updateProject", ({ request, headers, params }) =>
      adminMutation(request, headers, ProjectSettings, (settings) => ({
        action: "update",
        projectId: params.projectId,
        expectedRevision: Number(headers["if-match"].slice(1, -1)),
        settings,
      })),
    )
    .handleRaw("transitionProject", ({ request, headers, params }) =>
      adminMutation(
        request,
        headers,
        Schema.Struct({ action: Schema.Literals(["suspend", "reactivate", "retire"]) }),
        (input) => ({
          ...input,
          projectId: params.projectId,
          expectedRevision: Number(headers["if-match"].slice(1, -1)),
        }),
      ),
    )
    .handleRaw("changeGrant", ({ request, headers, params }) =>
      adminMutation(
        request,
        headers,
        Schema.Struct({ action: Schema.Literals(["grant", "revoke"]), principalId: Schema.String }),
        (input) => ({
          ...input,
          projectId: params.projectId,
          expectedRevision: Number(headers["if-match"].slice(1, -1)),
        }),
      ),
    )
    .handleRaw("getProject", ({ params }) =>
      Effect.gen(function* () {
        const projects = yield* Projects;
        const { actorId } = yield* AdminContext;
        return yield* adminRead(projects.get(actorId, params.projectId));
      }),
    )
    .handleRaw("listProjects", ({ query }) =>
      Effect.gen(function* () {
        const projects = yield* Projects;
        const { actorId } = yield* AdminContext;
        return yield* adminRead(projects.list(actorId, query));
      }),
    )
    .handleRaw("projectAudit", ({ params, query }) =>
      Effect.gen(function* () {
        const projects = yield* Projects;
        const { actorId } = yield* AdminContext;
        return yield* adminRead(projects.audit(actorId, params.projectId, query));
      }),
    ),
);
