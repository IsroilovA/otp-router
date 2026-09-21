import { Context, Schema, type Effect } from "effect";
import {
  Identifier,
  Opaque,
  Locale,
  Code,
  RoutingContext,
  Choice,
  DeliveryInput,
} from "./input.js";
import type { DomainError } from "../errors.js";
export const PrepareInput = Schema.Struct({
  recipient: Schema.Struct({
    type: Schema.Literal("phone"),
    phoneNumber: Schema.String.check(Schema.isMaxLength(64)),
  }),
  purpose: Identifier,
  contextId: Opaque,
  policyId: Identifier,
  expiresAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u),
  ).check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
  locale: Schema.optionalKey(Locale),
  deliveryChoice: Schema.optionalKey(Choice),
  routingContext: Schema.optionalKey(RoutingContext),
});
export type PrepareInput = typeof PrepareInput.Type;
export const CreateInput = Schema.Struct({ ...PrepareInput.fields, code: Code });
export const SubmitInput = Schema.Struct({ code: Code });
export const Action = Schema.Struct({
  allowed: Schema.Boolean,
  reason: Schema.optionalKey(
    Schema.Literals([
      "operation_unavailable",
      "code_required",
      "cooldown_active",
      "rate_limited",
      "manual_selection_disabled",
      "no_next_provider",
      "provider_unavailable",
      "delivery_unavailable",
    ]),
  ),
  availableAt: Schema.optionalKey(Schema.String),
});
export const Snapshot = Schema.Struct({
  operationId: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  state: Schema.Literals([
    "prepared",
    "queued",
    "sending",
    "accepted",
    "uncertain",
    "failed",
    "closed",
    "expired",
  ]),
  reason: Schema.NullOr(
    Schema.Literals([
      "delivery_failed",
      "delivery_uncertain",
      "invalid_recipient",
      "rate_limited",
      "provider_unavailable",
    ]),
  ),
  channel: Schema.NullOr(Identifier),
  provider: Schema.NullOr(Schema.Struct({ id: Identifier, label: Schema.String })),
  expiresAt: Schema.String,
  serverTime: Schema.String,
  actions: Schema.Struct({
    submitCode: Action,
    close: Action,
    resend: Action,
    next: Action,
    select: Schema.Struct({
      ...Action.fields,
      choices: Schema.Array(
        Schema.Struct({
          providerInstanceId: Identifier,
          channel: Identifier,
          label: Schema.String,
        }),
      ),
    }),
  }),
});
export type Snapshot = typeof Snapshot.Type;
export const DeliveryEvent = Schema.Struct({
  eventId: Schema.String.check(Schema.isUUID()),
  type: Schema.Literal("delivery.updated"),
  occurredAt: Schema.String,
  delivery: Snapshot,
});
export type DeliveryEvent = typeof DeliveryEvent.Type;
export const OperationResult = Schema.Struct({
  outcome: Schema.Literals(["prepared", "created", "completed", "delivery_queued"]),
  body: Snapshot,
  replayed: Schema.Boolean,
});
export type OperationResult = typeof OperationResult.Type;
const mutation = <S extends Schema.Top>(input: S) =>
  Schema.Struct({ key: Opaque, requestId: Opaque, input });
const targeted = <S extends Schema.Top>(input: S) =>
  Schema.Struct({ ...mutation(input).fields, operationId: Schema.String });
export const PrepareRequest = mutation(PrepareInput);
export const CreateRequest = mutation(CreateInput);
export const SubmitRequest = targeted(SubmitInput);
export const DeliverRequest = targeted(DeliveryInput);
export const CloseRequest = targeted(Schema.Struct({}));
export class Delivery extends Context.Service<
  Delivery,
  {
    readonly prepare: (
      request: typeof PrepareRequest.Type,
    ) => Effect.Effect<OperationResult, DomainError>;
    readonly create: (
      request: typeof CreateRequest.Type,
    ) => Effect.Effect<OperationResult, DomainError>;
    readonly submitCode: (
      request: typeof SubmitRequest.Type,
    ) => Effect.Effect<OperationResult, DomainError>;
    readonly status: (id: string) => Effect.Effect<OperationResult, DomainError>;
    readonly deliver: (
      request: typeof DeliverRequest.Type,
    ) => Effect.Effect<OperationResult, DomainError>;
    readonly close: (
      request: typeof CloseRequest.Type,
    ) => Effect.Effect<OperationResult, DomainError>;
  }
>()("otp-router/Delivery") {}
