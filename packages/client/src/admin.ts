import { Effect } from "effect";
import type { HttpApiSchema } from "effect/unstable/httpapi";
import type { HttpClientResponse } from "effect/unstable/http";
import type {
  AdminClientOptions,
  AdminMutationOptions,
  MutationOptions,
  RequestOptions,
  CreateProjectTransferDto,
  ProjectSettingsTransferDto,
  HistoryQueryDto,
} from "./contracts.js";
import { makeTransport } from "./transport.js";

const projectBody = <A, H, E, R>(
  effect: Effect.Effect<
    readonly [HttpApiSchema.withHeaders<A, H>, HttpClientResponse.HttpClientResponse],
    E,
    R
  >,
) => effect.pipe(Effect.map(([value, response]) => [value.body, response] as const));

/** Administrator credentials are independent of backend project credentials. */
export const createAdminClient = (options: AdminClientOptions) => {
  const execute = makeTransport(options);
  const headers = (request: AdminMutationOptions) => ({
    "idempotency-key": request.idempotencyKey,
    "if-match": request.etag,
  });
  const transition = (
    projectId: string,
    action: "suspend" | "reactivate" | "retire",
    request: AdminMutationOptions,
  ) =>
    execute(
      (client) =>
        client.administration
          .transitionProject({
            params: { projectId },
            payload: { action },
            headers: headers(request),
            responseMode: "decoded-and-response",
          })
          .pipe(projectBody),
      request,
    );
  const changeGrant = (
    projectId: string,
    principalId: string,
    action: "grant" | "revoke",
    request: AdminMutationOptions,
  ) =>
    execute(
      (client) =>
        client.administration
          .changeGrant({
            params: { projectId },
            payload: { action, principalId },
            headers: headers(request),
            responseMode: "decoded-and-response",
          })
          .pipe(projectBody),
      request,
    );
  return {
    createProject: (input: CreateProjectTransferDto, request: MutationOptions) =>
      execute(
        (client) =>
          client.administration
            .createProject({
              payload: input,
              headers: { "idempotency-key": request.idempotencyKey },
              responseMode: "decoded-and-response",
            })
            .pipe(projectBody),
        request,
      ),
    getProject: (projectId: string, request: RequestOptions = {}) =>
      execute(
        (client) =>
          client.administration
            .getProject({
              params: { projectId },
              responseMode: "decoded-and-response",
            })
            .pipe(projectBody),
        request,
      ),
    listProjects: (query: HistoryQueryDto = {}, request: RequestOptions = {}) =>
      execute(
        (client) =>
          client.administration.listProjects({ query, responseMode: "decoded-and-response" }),
        request,
      ),
    updateProject: (
      projectId: string,
      settings: ProjectSettingsTransferDto,
      request: AdminMutationOptions,
    ) =>
      execute(
        (client) =>
          client.administration
            .updateProject({
              params: { projectId },
              payload: settings,
              headers: headers(request),
              responseMode: "decoded-and-response",
            })
            .pipe(projectBody),
        request,
      ),
    suspendProject: (projectId: string, request: AdminMutationOptions) =>
      transition(projectId, "suspend", request),
    reactivateProject: (projectId: string, request: AdminMutationOptions) =>
      transition(projectId, "reactivate", request),
    retireProject: (projectId: string, request: AdminMutationOptions) =>
      transition(projectId, "retire", request),
    grantPrincipal: (projectId: string, principalId: string, request: AdminMutationOptions) =>
      changeGrant(projectId, principalId, "grant", request),
    revokePrincipal: (projectId: string, principalId: string, request: AdminMutationOptions) =>
      changeGrant(projectId, principalId, "revoke", request),
    listAudit: (projectId: string, query: HistoryQueryDto = {}, request: RequestOptions = {}) =>
      execute(
        (client) =>
          client.administration.projectAudit({
            params: { projectId },
            query,
            responseMode: "decoded-and-response",
          }),
        request,
      ),
  };
};
export type OtpRouterAdminClient = ReturnType<typeof createAdminClient>;
