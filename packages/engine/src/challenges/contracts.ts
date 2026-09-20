import type { Effect } from "effect";
import { Context, Data, Schema } from "effect";

export const Identifier = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
);
export const Opaque = Schema.String.pipe(Schema.check(Schema.isPattern(/^[!-~]{1,128}$/)));
export const Locale = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/)));
export const Code = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9]{6,8}$/)));
export const Primitive = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]);
export const RoutingContext = Schema.Record(Schema.String, Primitive).pipe(
  Schema.check(Schema.makeFilter((value) => Buffer.byteLength(JSON.stringify(value)) <= 4096)),
);
export const Choice = Schema.Union([
  Schema.Struct({ type: Schema.Literal("channel"), channel: Identifier }),
  Schema.Struct({ type: Schema.Literal("provider"), providerInstanceId: Identifier }),
]);
export type Choice = typeof Choice.Type;
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
export const DeliveryInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("resend") }),
  Schema.Struct({ action: Schema.Literal("next") }),
  Schema.Struct({ action: Schema.Literal("select"), choice: Choice }),
]);
export type DeliveryInput = typeof DeliveryInput.Type;
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
export const DeliveryResult = Schema.Struct({ deliveryId: Schema.String, challenge: Snapshot });
export const ErrorCode = Schema.Literals([
  "invalid_request",
  "challenge_not_found",
  "idempotency_conflict",
  "request_in_progress",
  "challenge_state_conflict",
  "challenge_unavailable",
  "incorrect_code",
  "invalid_recipient",
  "delivery_option_not_allowed",
  "policy_not_allowed",
  "delivery_unavailable",
  "rate_limited",
  "cooldown_active",
  "temporarily_unavailable",
]);
export type ErrorCode = typeof ErrorCode.Type;
export class DomainError<Code extends ErrorCode = ErrorCode> extends Data.TaggedError(
  "DomainError",
)<{
  readonly code: Code;
  readonly retryAt?: string;
}> {}

type MutationErrorCode =
  | "invalid_request"
  | "challenge_not_found"
  | "idempotency_conflict"
  | "request_in_progress"
  | "temporarily_unavailable";
type ActiveChallengeErrorCode = "challenge_state_conflict" | "challenge_unavailable";
export type CreateChallengeError = DomainError<
  | MutationErrorCode
  | "invalid_recipient"
  | "policy_not_allowed"
  | "delivery_unavailable"
  | "delivery_option_not_allowed"
  | "rate_limited"
>;
export type ChallengeStatusError = DomainError<
  "invalid_request" | "challenge_not_found" | "temporarily_unavailable"
>;
export type VerifyChallengeError = DomainError<
  MutationErrorCode | ActiveChallengeErrorCode | "invalid_request" | "rate_limited"
>;
export type DeliveryActionError = DomainError<
  | MutationErrorCode
  | ActiveChallengeErrorCode
  | "delivery_unavailable"
  | "delivery_option_not_allowed"
  | "rate_limited"
  | "cooldown_active"
>;
export type CancelChallengeError = DomainError<MutationErrorCode | "challenge_state_conflict">;
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
    ) => Effect.Effect<OperationResult, CreateChallengeError>;
    readonly status: (id: string) => Effect.Effect<OperationResult, ChallengeStatusError>;
    readonly verify: (
      request: ChallengeMutation<VerifyInput>,
    ) => Effect.Effect<OperationResult, VerifyChallengeError>;
    readonly deliver: (
      request: ChallengeMutation<DeliveryInput>,
    ) => Effect.Effect<OperationResult, DeliveryActionError>;
    readonly cancel: (
      request: ChallengeMutation<Record<string, never>>,
    ) => Effect.Effect<OperationResult, CancelChallengeError>;
  }
>()("otp-router/Router") {}
