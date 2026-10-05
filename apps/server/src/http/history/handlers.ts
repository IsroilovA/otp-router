import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerResponse } from "effect/unstable/http";
import { DeliveryHistory } from "@otp-router/engine/history";
import type { DomainError } from "@otp-router/engine/delivery";
import { OtpRouterApi } from "../api.js";
import { RequestContext } from "../contracts.js";
import { errorResponse } from "../errors.js";

const historyResponse = <A>(effect: Effect.Effect<A, DomainError>) =>
  Effect.gen(function* () {
    const { requestId } = yield* RequestContext;
    return yield* effect.pipe(
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body)),
      Effect.catchTag("DomainError", (error) => errorResponse(error.code, requestId)),
    );
  });
export const makeHistoryHandlers = HttpApiBuilder.group(OtpRouterApi, "history", (handlers) =>
  handlers
    .handleRaw("events", ({ params, query }) =>
      Effect.flatMap(DeliveryHistory, (history) =>
        Effect.flatMap(RequestContext, ({ principalId }) =>
          historyResponse(history.events(params.projectId, query, principalId)),
        ),
      ),
    )
    .handleRaw("attempts", ({ params, query }) =>
      Effect.flatMap(DeliveryHistory, (history) =>
        Effect.flatMap(RequestContext, ({ principalId }) =>
          historyResponse(
            history.attempts(params.projectId, params.operationId, query, principalId),
          ),
        ),
      ),
    )
    .handleRaw("attempt", ({ params }) =>
      Effect.flatMap(DeliveryHistory, (history) =>
        Effect.flatMap(RequestContext, ({ principalId }) =>
          historyResponse(history.attempt(params.projectId, params.attemptId, principalId)),
        ),
      ),
    )
    .handleRaw("operations", ({ params, query }) =>
      Effect.flatMap(DeliveryHistory, (history) =>
        Effect.flatMap(RequestContext, ({ principalId }) =>
          historyResponse(history.operations(params.projectId, query, principalId)),
        ),
      ),
    ),
);
