import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
  RuntimeCommand,
  ResourceSnapshot,
  ResourceKind,
  ResourcePage,
  Assignment,
  RuntimeAuditPage,
} from "@otp-router/engine/runtime";
import {
  AdminAuth,
  RequestValidation,
  MutationHeaders,
  HistoryQuery,
  adminErrors,
} from "../contracts.js";
import { ResourceNotFoundError, ResourceConflictError } from "../responses.js";

const ResourceResponse = HttpApiSchema.WithHeaders(ResourceSnapshot, {
  etag: Schema.String,
  "x-request-id": Schema.String,
  "idempotency-replayed": Schema.optionalKey(Schema.Literal("true")),
});
const RuntimeQuery = { after: Schema.optionalKey(Schema.String), limit: HistoryQuery.limit };
const runtimeErrors = [
  ...adminErrors,
  ResourceNotFoundError.pipe(HttpApiSchema.status(404)),
  ResourceConflictError.pipe(HttpApiSchema.status(409)),
];
export const RuntimeGroup = HttpApiGroup.make("runtimeAdministration").add(
  HttpApiEndpoint.post("mutate", "/v1/admin/runtime/commands", {
    headers: MutationHeaders,
    payload: Schema.Struct({ command: RuntimeCommand }),
    success: ResourceResponse,
    error: runtimeErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
  HttpApiEndpoint.get("get", "/v1/admin/runtime/:kind/:id", {
    params: { kind: ResourceKind, id: Schema.String },
    success: ResourceResponse,
    error: runtimeErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
  HttpApiEndpoint.get("list", "/v1/admin/runtime/:kind", {
    params: { kind: ResourceKind },
    query: RuntimeQuery,
    success: ResourcePage,
    error: runtimeErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
  HttpApiEndpoint.get("assignments", "/v1/admin/projects/:projectId/assignments", {
    params: { projectId: Schema.String },
    success: Schema.Array(Assignment),
    error: runtimeErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
  HttpApiEndpoint.get("audit", "/v1/admin/runtime/:kind/:id/audit", {
    params: { kind: ResourceKind, id: Schema.String },
    query: RuntimeQuery,
    success: RuntimeAuditPage,
    error: runtimeErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
);
