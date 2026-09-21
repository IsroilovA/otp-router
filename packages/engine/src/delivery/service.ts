import type { ApplicationOperation } from "../diagnostics/log.js";
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
type Mutation =
  | { readonly action: "submit"; readonly request: typeof SubmitRequest.Type }
  | { readonly action: "deliver"; readonly request: typeof DeliverRequest.Type }
  | { readonly action: "close"; readonly request: typeof CloseRequest.Type };

const mutate = (config: RuntimeConfiguration, command: Mutation) =>
  domainTransaction(
    config,
    Effect.gen(function* () {
      const { request, action } = command;
      const code = command.action === "submit" ? command.request.input.code : undefined;
      const input = command.action === "submit" ? {} : request.input;
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
      switch (command.action) {
        case "submit":
          yield* attachCode(config, operation, command.request.input.code);
          break;
        case "deliver":
          yield* requestSend(config, operation, command.request.input, time);
          break;
        case "close":
          if (operation.state !== "closed" && operation.state !== "expired")
            yield* terminate(operation, "closed", time);
          break;
      }
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
      operation: ApplicationOperation,
      effect: Effect.Effect<
        OperationResult,
        E,
        PgClient.PgClient | SqlClient.SqlClient | Queue | OwnerProjection
      >,
      requestId?: string,
    ) => observeOperation(operation, effect.pipe(Effect.provide(context)), requestId);
    const validate = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
      Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => new DomainError({ code: "invalid_request" })),
      );
    return {
      prepare: (request) =>
        run(
          "delivery.prepare",
          validate(PrepareRequest, request).pipe(Effect.flatMap((value) => prepare(config, value))),
          request.requestId,
        ),
      create: (request) =>
        run(
          "delivery.create",
          validate(CreateRequest, request).pipe(
            Effect.flatMap((value) => {
              const { code, ...input } = value.input;
              return prepare(config, { ...value, input }, code);
            }),
          ),
          request.requestId,
        ),
      submitCode: (request) =>
        run(
          "delivery.submitCode",
          validate(SubmitRequest, request).pipe(
            Effect.flatMap((value) => mutate(config, { action: "submit", request: value })),
          ),
          request.requestId,
        ),
      deliver: (request) =>
        run(
          "delivery.deliver",
          validate(DeliverRequest, request).pipe(
            Effect.flatMap((value) => mutate(config, { action: "deliver", request: value })),
          ),
          request.requestId,
        ),
      close: (request) =>
        run(
          "delivery.close",
          validate(CloseRequest, request).pipe(
            Effect.flatMap((value) => mutate(config, { action: "close", request: value })),
          ),
          request.requestId,
        ),
      status: (id) =>
        run(
          "delivery.status",
          validate(Schema.String, id).pipe(
            Effect.flatMap((value) => deliveryStatus(config, value)),
          ),
        ),
    };
  }),
);
