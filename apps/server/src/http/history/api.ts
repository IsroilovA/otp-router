import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { EventPage, AttemptPage, OperationPage } from "@otp-router/engine/history";
import { AttemptSnapshot } from "@otp-router/engine/delivery";
import {
  ApplicationAuth,
  RequestValidation,
  HistoryQuery,
  commonErrors,
  notFound,
} from "../contracts.js";
import { HistoryCursorExpiredError } from "../responses.js";

const HistoryCursorExpired = HistoryCursorExpiredError.pipe(HttpApiSchema.status(410));
export const HistoryGroup = HttpApiGroup.make("history").add(
  HttpApiEndpoint.get("events", "/v1/projects/:projectId/events", {
    params: { projectId: Schema.String },
    query: {
      ...HistoryQuery,
      operationId: Schema.optionalKey(Schema.String),
      attemptId: Schema.optionalKey(Schema.String),
    },
    success: EventPage,
    error: [...commonErrors, HistoryCursorExpired],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.get(
    "attempts",
    "/v1/projects/:projectId/delivery-operations/:operationId/attempts",
    {
      params: { projectId: Schema.String, operationId: Schema.String },
      query: HistoryQuery,
      success: AttemptPage,
      error: [...commonErrors, notFound, HistoryCursorExpired],
    },
  )
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.get("attempt", "/v1/projects/:projectId/attempts/:attemptId", {
    params: { projectId: Schema.String, attemptId: Schema.String },
    success: AttemptSnapshot,
    error: [...commonErrors, notFound],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
  HttpApiEndpoint.get("operations", "/v1/projects/:projectId/delivery-operations", {
    params: { projectId: Schema.String },
    query: HistoryQuery,
    success: OperationPage,
    error: [...commonErrors, HistoryCursorExpired],
  })
    .middleware(RequestValidation)
    .middleware(ApplicationAuth),
);
