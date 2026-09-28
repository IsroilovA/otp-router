import { Context, Schema, type Effect } from "effect";
import { ChallengeEvent } from "../challenges/contracts.js";
import { DeliveryEvent } from "../delivery/contracts.js";
import { AttemptEvent, EvidenceEvent, AttemptSnapshot } from "../delivery/history-contracts.js";
import type { DomainError } from "../errors.js";
export const HistoryEvent = Schema.Union([
  ChallengeEvent,
  DeliveryEvent,
  AttemptEvent,
  EvidenceEvent,
]);
export const PageInput = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export const EventPage = Schema.Struct({
  events: Schema.Array(HistoryEvent),
  nextCursor: Schema.String,
  hasMore: Schema.Boolean,
  highWaterMark: Schema.String,
  reconciliationDays: Schema.Int,
});
export const AttemptPage = Schema.Struct({
  attempts: Schema.Array(AttemptSnapshot),
  nextCursor: Schema.NullOr(Schema.String),
  retainUntil: Schema.NullOr(Schema.String),
});
export const OperationHistory = Schema.Struct({
  operationId: Schema.String,
  projectId: Schema.String,
  state: Schema.String,
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  retainUntil: Schema.NullOr(Schema.String),
});
export const OperationPage = Schema.Struct({
  operations: Schema.Array(OperationHistory),
  nextCursor: Schema.NullOr(Schema.String),
});
export class DeliveryHistory extends Context.Service<
  DeliveryHistory,
  {
    readonly events: (
      projectId: string,
      input: typeof PageInput.Type & { readonly operationId?: string; readonly attemptId?: string },
    ) => Effect.Effect<typeof EventPage.Type, DomainError>;
    readonly attempts: (
      projectId: string,
      operationId: string,
      input: typeof PageInput.Type,
    ) => Effect.Effect<typeof AttemptPage.Type, DomainError>;
    readonly attempt: (
      projectId: string,
      attemptId: string,
    ) => Effect.Effect<typeof AttemptSnapshot.Type, DomainError>;
    readonly operations: (
      projectId: string,
      input: typeof PageInput.Type,
    ) => Effect.Effect<typeof OperationPage.Type, DomainError>;
  }
>()("otp-router/DeliveryHistory") {}
