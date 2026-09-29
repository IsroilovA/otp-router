import { requireAccess } from "../projects/store.js";
import { domainTransaction } from "../delivery/transaction.js";
import { observeOperation } from "../diagnostics/operation.js";
import { DeliveryOwner } from "../delivery/owner.js";
import { SqlClient } from "effect/unstable/sql";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Schema } from "effect";
import { RouterConfig } from "../config/runtime.js";

import { Queue } from "../queue/client.js";
import { requestDelivery } from "./deliver.js";
import {
  Router,
  CreateRequest,
  VerifyRequest,
  DeliveryRequest,
  CancelRequest,
} from "./contracts.js";
import { DomainError } from "../errors.js";
import { createChallenge } from "./create.js";
import { verifyChallenge } from "./verify.js";
import { cancelChallenge } from "./cancel.js";
import { findProjectChallenge } from "./store.js";
import { challengeStatus } from "./status.js";

const validate = <S extends Schema.Top>(schema: S, input: S["Type"]) =>
  Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new DomainError({ code: "invalid_request" })),
  );

export const RouterLive = Layer.effect(
  Router,
  Effect.gen(function* () {
    const config = yield* RouterConfig;
    const pg = yield* PgClient.PgClient;
    const queue = yield* Queue;
    const owner = yield* DeliveryOwner;
    const provide = <A, E>(
      effect: Effect.Effect<A, E, PgClient.PgClient | SqlClient.SqlClient | Queue | DeliveryOwner>,
    ) =>
      effect.pipe(
        Effect.provideService(PgClient.PgClient, pg),
        Effect.provideService(Queue, queue),
        Effect.provideService(DeliveryOwner, owner),
        Effect.provideService(SqlClient.SqlClient, pg),
      );
    return {
      create: (request) =>
        observeOperation(
          "create",
          validate(CreateRequest, request).pipe(
            Effect.flatMap((valid) => provide(createChallenge(config, valid))),
          ),
          request.requestId,
        ),
      status: (projectId, id, principalId) =>
        observeOperation(
          "status",
          validate(Schema.String, id).pipe(
            Effect.flatMap((valid) =>
              provide(
                domainTransaction(
                  config,
                  requireAccess(projectId, principalId).pipe(
                    Effect.andThen(findProjectChallenge(projectId, valid)),
                    Effect.andThen(challengeStatus(config, valid)),
                  ),
                ),
              ),
            ),
          ),
        ),
      verify: (request) =>
        observeOperation(
          "verify",
          validate(VerifyRequest, request).pipe(
            Effect.flatMap((valid) => provide(verifyChallenge(config, valid))),
          ),
          request.requestId,
        ),
      cancel: (request) =>
        observeOperation(
          "cancel",
          validate(CancelRequest, request).pipe(
            Effect.flatMap((valid) => provide(cancelChallenge(config, valid))),
          ),
          request.requestId,
        ),
      deliver: (request) =>
        observeOperation(
          "deliver",
          validate(DeliveryRequest, request).pipe(
            Effect.flatMap((valid) => provide(requestDelivery(config, valid))),
          ),
          request.requestId,
        ),
    };
  }),
);
