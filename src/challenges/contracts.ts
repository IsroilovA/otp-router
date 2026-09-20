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
export const VerificationState = Schema.Literals([
  "active",
  "verified",
  "locked",
  "expired",
  "cancelled",
]);
export const DeliveryState = Schema.Literals([
  "pending",
  "dispatching",
  "accepted",
  "delivered",
  "failed",
  "uncertain",
  "suppressed",
]);
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
  purpose: Identifier,
  contextId: Opaque,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  serverTime: Schema.String,
  verificationState: VerificationState,
  verifiedAt: Schema.optionalKey(Schema.String),
  delivery: Schema.Struct({
    deliveryId: Schema.String,
    channel: Identifier,
    state: DeliveryState,
    routing: Schema.Literals(["pending", "waiting", "exhausted", "blocked"]),
  }),
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
  "unauthorized",
  "challenge_not_found",
  "idempotency_conflict",
  "request_in_progress",
  "challenge_state_conflict",
  "challenge_unavailable",
  "request_too_large",
  "incorrect_code",
  "invalid_recipient",
  "delivery_option_not_allowed",
  "policy_not_allowed",
  "delivery_unavailable",
  "rate_limited",
  "cooldown_active",
  "internal_error",
  "temporarily_unavailable",
]);
export type ErrorCode = typeof ErrorCode.Type;
export const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: ErrorCode,
    message: Schema.String,
    requestId: Schema.String,
    retryAt: Schema.optionalKey(Schema.String),
    verificationState: Schema.optionalKey(Schema.Literals(["active", "locked"])),
  }),
});
export class DomainError<Code extends ErrorCode = ErrorCode> extends Data.TaggedError(
  "DomainError",
)<{
  readonly code: Code;
  readonly retryAt?: string;
}> {}

type MutationErrorCode =
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
export type ChallengeStatusError = DomainError<"challenge_not_found" | "temporarily_unavailable">;
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
export const ResponseBody = Schema.Union([Snapshot, VerificationResult, DeliveryResult, ErrorBody]);
export type ResponseBody = typeof ResponseBody.Type;
export interface OperationResult {
  readonly status: number;
  readonly body: ResponseBody;
  readonly replayed: boolean;
}
export interface Mutation<A> {
  readonly key: string;
  readonly input: A;
  readonly requestId: string;
}
export interface ChallengeMutation<A> extends Mutation<A> {
  readonly challengeId: string;
}
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
export const statusForError = (code: ErrorCode): number => {
  switch (code) {
    case "invalid_request":
      return 400;
    case "unauthorized":
      return 401;
    case "challenge_not_found":
      return 404;
    case "idempotency_conflict":
    case "request_in_progress":
    case "challenge_state_conflict":
      return 409;
    case "challenge_unavailable":
      return 410;
    case "request_too_large":
      return 413;
    case "incorrect_code":
    case "invalid_recipient":
    case "delivery_option_not_allowed":
    case "policy_not_allowed":
    case "delivery_unavailable":
      return 422;
    case "rate_limited":
    case "cooldown_active":
      return 429;
    case "internal_error":
      return 500;
    case "temporarily_unavailable":
      return 503;
  }
};
