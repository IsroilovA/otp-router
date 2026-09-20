import { PgClient } from "@effect/sql-pg";
import { Effect, Layer } from "effect";
import { RouterConfig } from "../config/config.js";
import { Queue } from "../queue/client.js";
import { logEvent } from "../diagnostics/log.js";
import { count } from "../diagnostics/metrics.js";
import { requestDelivery } from "../delivery/actions.js";
import { DomainError, Router, type OperationResult } from "./contracts.js";
import { createChallenge } from "./create.js";
import { verifyChallenge } from "./verify.js";
import { cancelChallenge, challengeStatus } from "./cancel.js";

export const RouterLive = Layer.effect(
  Router,
  Effect.gen(function* () {
    const config = yield* RouterConfig;
    const pg = yield* PgClient.PgClient;
    const queue = yield* Queue;
    const provide = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient | SqlClient | Queue>) =>
      effect.pipe(
        Effect.provideService(PgClient.PgClient, pg),
        Effect.provideService(Queue, queue),
        Effect.provideService(importSqlClient, pg),
        Effect.mapError((error) =>
          error instanceof DomainError
            ? error
            : new DomainError({ code: "temporarily_unavailable" }),
        ),
      );
    const observe = (
      name: "create" | "verify" | "cancel" | "deliver" | "status",
      effect: Effect.Effect<OperationResult, DomainError>,
      requestId?: string,
    ) =>
      effect.pipe(
        Effect.tap((result) =>
          count(name, "error" in result.body ? result.body.error.code : "completed"),
        ),
        Effect.tap((result) =>
          logEvent({
            event: "application_operation",
            outcome: `${name}:${result.status}`,
            ...(requestId === undefined ? {} : { requestId }),
          }),
        ),
        Effect.tapError((error) => count(name, error.code)),
        Effect.tapError((error) =>
          logEvent({
            event: "application_operation",
            outcome: "rejected",
            reason: error.code,
            ...(requestId === undefined ? {} : { requestId }),
          }),
        ),
      );
    return {
      create: (request) =>
        observe("create", provide(createChallenge(config, request)), request.requestId),
      status: (id) => observe("status", provide(challengeStatus(config, id))),
      verify: (request) =>
        observe("verify", provide(verifyChallenge(config, request)), request.requestId),
      cancel: (request) =>
        observe("cancel", provide(cancelChallenge(config, request)), request.requestId),
      deliver: (request) =>
        observe("deliver", provide(requestDelivery(config, request)), request.requestId),
    };
  }),
);
import { SqlClient as importSqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
