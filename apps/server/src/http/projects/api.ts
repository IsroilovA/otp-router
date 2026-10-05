import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
  ProjectSnapshot,
  ProjectSettings,
  CreateProjectInput,
  ProjectPage,
  AuditPage,
} from "@otp-router/engine/projects";
import {
  AdminAuth,
  RequestValidation,
  MutationHeaders,
  RevisionHeaders,
  HistoryQuery,
  adminErrors,
} from "../contracts.js";

const ProjectResponse = HttpApiSchema.WithHeaders(ProjectSnapshot, {
  etag: Schema.String.check(Schema.isPattern(/^"[1-9][0-9]*"$/u)),
  "idempotency-replayed": Schema.optionalKey(Schema.Literal("true")),
  "x-request-id": Schema.String,
});
export const AdminGroup = HttpApiGroup.make("administration").add(
  HttpApiEndpoint.post("createProject", "/v1/admin/projects", {
    headers: MutationHeaders,
    payload: CreateProjectInput,
    success: ProjectResponse.pipe(HttpApiSchema.status(201)),
    error: adminErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
  HttpApiEndpoint.get("getProject", "/v1/admin/projects/:projectId", {
    params: { projectId: Schema.String },
    success: ProjectResponse,
    error: adminErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
  HttpApiEndpoint.get("listProjects", "/v1/admin/projects", {
    query: HistoryQuery,
    success: ProjectPage,
    error: adminErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
  HttpApiEndpoint.put("updateProject", "/v1/admin/projects/:projectId", {
    params: { projectId: Schema.String },
    headers: RevisionHeaders,
    payload: ProjectSettings,
    success: ProjectResponse,
    error: adminErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
  HttpApiEndpoint.post("transitionProject", "/v1/admin/projects/:projectId/lifecycle", {
    params: { projectId: Schema.String },
    headers: RevisionHeaders,
    payload: Schema.Struct({ action: Schema.Literals(["suspend", "reactivate", "retire"]) }),
    success: ProjectResponse,
    error: adminErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
  HttpApiEndpoint.post("changeGrant", "/v1/admin/projects/:projectId/grants", {
    params: { projectId: Schema.String },
    headers: RevisionHeaders,
    payload: Schema.Struct({
      action: Schema.Literals(["grant", "revoke"]),
      principalId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/u)),
    }),
    success: ProjectResponse,
    error: adminErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
  HttpApiEndpoint.get("projectAudit", "/v1/admin/projects/:projectId/audit", {
    params: { projectId: Schema.String },
    query: HistoryQuery,
    success: AuditPage,
    error: adminErrors,
  })
    .middleware(RequestValidation)
    .middleware(AdminAuth),
);
