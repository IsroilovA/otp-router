import type { Operation } from "./records.js";
import { observeOperation, type InfrastructureError } from "../diagnostics/operation.js";
import { admissionLimit, lockQuotas } from "./quotas.js";
import type { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { RouterConfig } from "../config/runtime.js";
import { databaseTime } from "../database/transaction.js";
import { DomainError } from "../errors.js";
import type { Queue } from "../queue/client.js";
import {
  Delivery,
  PrepareRequest,
  CreateRequest,
  SubmitRequest,
  DeliverRequest,
  CloseRequest,
  type OperationResult,
} from "./contracts.js";
import type { OwnerProjection } from "./projection.js";
import { domainTransaction, deliveryTransaction } from "./transaction.js";
import { prepareRoute, normalizePhone } from "./prepare.js";
import { admitOperation, attachCode } from "./lifecycle.js";
import { findOperation, expire, requireExternal, terminate } from "./store.js";
import { snapshot } from "./publication.js";
import { identity, replay, save } from "./idempotency.js";
import { requestSend } from "./actions.js";
import type { RuntimeConfiguration } from "../config/config.js";

const prepare = (
  config: RuntimeConfiguration,
  request: typeof PrepareRequest.Type,
  code?: string,
) =>
  Effect.gen(function* () {
    const phone = yield* normalizePhone(request.input.recipient.phoneNumber);
    const input = { ...request.input, recipient: { type: "phone" as const, phoneNumber: phone } };
    const id = identity(config.settings.crypto, code === undefined ? "prepare" : "create", request);
    const previous = yield* domainTransaction(
      config,
      replay(config.settings.crypto, id, input, code),
    );
    if (previous !== undefined) return previous;
    const route = yield* prepareRoute(config, input);
    return yield* deliveryTransaction(
      config,
      Effect.gen(function* () {
        const existing = yield* replay(config.settings.crypto, id, input, code);
        if (existing !== undefined) return existing;
        const operation = yield* admitOperation(config, input, { ...route, owner: "external" });
        const attached =
          code === undefined ? operation : yield* attachCode(config, operation, code);
        const time = yield* databaseTime;
        const response: OperationResult = {
          outcome: code === undefined ? "prepared" : "created",
          body: yield* snapshot(config, attached, time),
          replayed: false,
        };
        return yield* save(config.settings.crypto, id, input, {
          response,
          active: true,
          time,
          ...(code === undefined ? {} : { code }),
        });
      }),
    );
  });
const mutate = (
  config: RuntimeConfiguration,
  request: typeof SubmitRequest.Type | typeof DeliverRequest.Type | typeof CloseRequest.Type,
  action: "submit" | "deliver" | "close",
) =>
  domainTransaction(
    config,
    Effect.gen(function* () {
      const code = "code" in request.input ? request.input.code : undefined;
      const input = code === undefined ? request.input : {};
      const id = identity(config.settings.crypto, action, request);
      const previous = yield* replay(config.settings.crypto, id, input, code);
      // Existing results have no new send effects, including after terminal fingerprint erasure.
      if (previous !== undefined) return previous;
      const initial = yield* findOperation(request.operationId);
      if (action === "deliver") yield* lockQuotas([admissionLimit(initial.recipient_token)]);
      const locked = yield* findOperation(request.operationId, true);
      yield* requireExternal(locked);
      const time = yield* databaseTime;
      const operation = yield* expire(locked, time);
      yield* applyAction(config, operation, request, { action, code, time });
      const current = yield* findOperation(operation.id);
      const response: OperationResult = {
        outcome:
          action === "close" || (action === "submit" && operation.state === "active")
            ? "completed"
            : "delivery_queued",
        body: yield* snapshot(config, current, time),
        replayed: false,
      };
      return yield* save(config.settings.crypto, id, input, {
        response,
        active: current.state === "active" || current.state === "prepared",
        time,
        ...(code === undefined ? {} : { code }),
      });
    }),
  );
export const deliveryStatus = (config: RuntimeConfiguration, id: string) =>
  domainTransaction(
    config,
    Effect.gen(function* () {
      const locked = yield* findOperation(id, true);
      const time = yield* databaseTime;
      const operation = yield* expire(locked, time);
      return {
        outcome: "completed",
        body: yield* snapshot(config, operation, time),
        replayed: false,
      } satisfies OperationResult;
    }),
  );
export const DeliveryLive = Layer.effect(
  Delivery,
  Effect.gen(function* () {
    const config = yield* RouterConfig;
    const context = yield* Effect.context<
      PgClient.PgClient | SqlClient.SqlClient | Queue | OwnerProjection
    >();
    const run = <E extends DomainError | InfrastructureError>(
      effect: Effect.Effect<
        OperationResult,
        E,
        PgClient.PgClient | SqlClient.SqlClient | Queue | OwnerProjection
      >,
    ) => observeOperation("external_delivery", effect.pipe(Effect.provide(context)));
    const validate = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
      Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => new DomainError({ code: "invalid_request" })),
      );
    return {
      prepare: (request) =>
        run(
          validate(PrepareRequest, request).pipe(Effect.flatMap((value) => prepare(config, value))),
        ),
      create: (request) =>
        run(
          validate(CreateRequest, request).pipe(
            Effect.flatMap((value) => {
              const { code, ...input } = value.input;
              return prepare(config, { ...value, input }, code);
            }),
          ),
        ),
      submitCode: (request) =>
        run(
          validate(SubmitRequest, request).pipe(
            Effect.flatMap((value) => mutate(config, value, "submit")),
          ),
        ),
      deliver: (request) =>
        run(
          validate(DeliverRequest, request).pipe(
            Effect.flatMap((value) => mutate(config, value, "deliver")),
          ),
        ),
      close: (request) =>
        run(
          validate(CloseRequest, request).pipe(
            Effect.flatMap((value) => mutate(config, value, "close")),
          ),
        ),
      status: (id) =>
        run(
          validate(Schema.String, id).pipe(
            Effect.flatMap((value) => deliveryStatus(config, value)),
          ),
        ),
    };
  }),
);

const applyAction = (
  config: RuntimeConfiguration,
  operation: Operation,
  request: typeof SubmitRequest.Type | typeof DeliverRequest.Type | typeof CloseRequest.Type,
  options: {
    readonly action: "submit" | "deliver" | "close";
    readonly code: string | undefined;
    readonly time: Date;
  },
) =>
  Effect.gen(function* () {
    const { action, code, time } = options;
    if (action === "submit" && code !== undefined) yield* attachCode(config, operation, code);
    else if (action === "deliver" && "action" in request.input)
      yield* requestSend(config, operation, request.input, time);
    else if (action === "close" && operation.state !== "closed" && operation.state !== "expired")
      yield* terminate(operation, "closed", time);
  });
