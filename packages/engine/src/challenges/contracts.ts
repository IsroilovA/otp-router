import type { DomainError } from "../errors.js";
import {
  Identifier,
  Opaque,
  Locale,
  Code,
  RoutingContext,
  Choice,
  DeliveryInput,
} from "../delivery/input.js";
import type { Effect } from "effect";
import { Context, Schema } from "effect";

export const CreateInput = Schema.Struct({
  recipient: Schema.Struct({
    type: Schema.Literal("phone"),
    phoneNumber: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
  }),
  purpose: Identifier,
  contextId: Opaque,
  policyId: Identifier,
  locale: Schema.optionalKey(Locale),
  deliveryChoice: Schema.optionalKey(Choice),
  routingContext: Schema.optionalKey(RoutingContext),
});
export type CreateInput = typeof CreateInput.Type;
export const VerifyInput = Schema.Struct({ code: Code, purpose: Identifier, contextId: Opaque });
export type VerifyInput = typeof VerifyInput.Type;
export const DeniedReason = Schema.Literals([
  "challenge_unavailable",
  "already_verified",
  "cooldown_active",
  "rate_limited",
  "manual_selection_disabled",
  "no_next_provider",
  "provider_unavailable",
  "delivery_unavailable",
]);
export const Action = Schema.Struct({
  allowed: Schema.Boolean,
  reason: Schema.optionalKey(DeniedReason),
  availableAt: Schema.optionalKey(Schema.String),
});
export const Snapshot = Schema.Struct({
  operationId: Schema.String,
  challengeId: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  state: Schema.Literals(["queued", "sending", "accepted", "uncertain", "verified", "failed"]),
  reason: Schema.NullOr(
    Schema.Literals([
      "expired",
      "cancelled",
      "locked",
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
    verify: Action,
    resend: Action,
    next: Action,
    cancel: Action,
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
export const ChallengeEvent = Schema.Struct({
  eventId: Schema.String.check(Schema.isUUID()),
  type: Schema.Literal("challenge.updated"),
  occurredAt: Schema.String,
  challenge: Snapshot,
});
export type ChallengeEvent = typeof ChallengeEvent.Type;
export const VerificationResult = Schema.Struct({
  verificationId: Schema.String,
  challengeId: Schema.String,
  purpose: Identifier,
  contextId: Opaque,
  verifiedAt: Schema.String,
});
export const DeliveryResult = Schema.Struct({ attemptId: Schema.String, challenge: Snapshot });
export const IncorrectCodeResult = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("incorrect_code"),
    requestId: Schema.String,
    reason: Schema.optionalKey(Schema.Literal("locked")),
  }),
});
export const ResultBody = Schema.Union([
  Snapshot,
  VerificationResult,
  DeliveryResult,
  IncorrectCodeResult,
]);
export const OperationOutcome = Schema.Literals([
  "created",
  "completed",
  "delivery_queued",
  "incorrect_code",
]);
export const OperationResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("created"), body: Snapshot, replayed: Schema.Boolean }),
  Schema.Struct({
    outcome: Schema.Literal("completed"),
    body: Schema.Union([Snapshot, VerificationResult]),
    replayed: Schema.Boolean,
  }),
  Schema.Struct({
    outcome: Schema.Literal("delivery_queued"),
    body: DeliveryResult,
    replayed: Schema.Boolean,
  }),
  Schema.Struct({
    outcome: Schema.Literal("incorrect_code"),
    body: IncorrectCodeResult,
    replayed: Schema.Boolean,
  }),
]);
export type OperationResult = typeof OperationResult.Type;
const mutation = <S extends Schema.Top>(input: S) =>
  Schema.Struct({ key: Opaque, input, requestId: Opaque });
const challengeMutation = <S extends Schema.Top>(input: S) =>
  Schema.Struct({ ...mutation(input).fields, challengeId: Schema.String });
export const CreateRequest = mutation(CreateInput);
export const VerifyRequest = challengeMutation(VerifyInput);
export const DeliveryRequest = challengeMutation(DeliveryInput);
export const CancelRequest = challengeMutation(Schema.Record(Schema.String, Schema.Never));
export type Mutation<A> = { readonly key: string; readonly input: A; readonly requestId: string };
export type ChallengeMutation<A> = Mutation<A> & { readonly challengeId: string };
export class Router extends Context.Service<
  Router,
  {
    readonly create: (
      request: Mutation<CreateInput>,
    ) => Effect.Effect<OperationResult, DomainError>;
    readonly status: (id: string) => Effect.Effect<OperationResult, DomainError>;
    readonly verify: (
      request: ChallengeMutation<VerifyInput>,
    ) => Effect.Effect<OperationResult, DomainError>;
    readonly deliver: (
      request: ChallengeMutation<DeliveryInput>,
    ) => Effect.Effect<OperationResult, DomainError>;
    readonly cancel: (
      request: ChallengeMutation<Record<string, never>>,
    ) => Effect.Effect<OperationResult, DomainError>;
  }
>()("otp-router/Router") {}
