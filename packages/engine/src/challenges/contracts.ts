import type { DomainError } from "../errors.js";
import {
  Identifier,
  Opaque,
  Locale,
  Code,
  RoutingContext,
  Choice,
  DeliveryInput,
  IntegrationReference,
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
  integrationReference: Schema.optionalKey(IntegrationReference),
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
  projectId: Identifier,
  operationId: Schema.String,
  integrationReference: Schema.optionalKey(IntegrationReference),
  challengeId: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  state: Schema.Literals(["queued", "sending", "accepted", "uncertain", "verified", "failed"]),
  reason: Schema.NullOr(
    Schema.Literals([
      "expired",
      "cancelled",
      "locked",
      "delivery_failed",
      "authorization_pending",
      "authorization_denied",
      "authorization_expired",
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
  projectId: Identifier,
  sequence: Schema.String,
  eventId: Schema.String.check(Schema.isUUID()),
  type: Schema.Literal("challenge.updated"),
  occurredAt: Schema.String,
  challenge: Snapshot,
});
export type ChallengeEvent = typeof ChallengeEvent.Type;
export const VerificationResult = Schema.Struct({
  projectId: Identifier,
  integrationReference: Schema.optionalKey(IntegrationReference),
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
export const CreateResult = Schema.Struct({
  outcome: Schema.Literal("created"),
  body: Snapshot,
  replayed: Schema.Boolean,
});
export type CreateResult = typeof CreateResult.Type;
export const StatusResult = Schema.Struct({
  outcome: Schema.Literal("completed"),
  body: Snapshot,
  replayed: Schema.Boolean,
});
export type StatusResult = typeof StatusResult.Type;
export const VerifyResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("completed"),
    body: VerificationResult,
    replayed: Schema.Boolean,
  }),
  Schema.Struct({
    outcome: Schema.Literal("incorrect_code"),
    body: IncorrectCodeResult,
    replayed: Schema.Boolean,
  }),
]);
export type VerifyResult = typeof VerifyResult.Type;
export const SendResult = Schema.Struct({
  outcome: Schema.Literal("delivery_queued"),
  body: DeliveryResult,
  replayed: Schema.Boolean,
});
export type SendResult = typeof SendResult.Type;
export const OperationResult = Schema.Union([CreateResult, StatusResult, VerifyResult, SendResult]);
export type OperationResult = typeof OperationResult.Type;
const mutation = <S extends Schema.Top>(input: S) =>
  Schema.Struct({
    principalId: Identifier,
    projectId: Identifier,
    key: Opaque,
    input,
    requestId: Opaque,
  });
const challengeMutation = <S extends Schema.Top>(input: S) =>
  Schema.Struct({ ...mutation(input).fields, challengeId: Schema.String });
export const CreateRequest = mutation(CreateInput);
export const VerifyRequest = challengeMutation(VerifyInput);
export const DeliveryRequest = challengeMutation(DeliveryInput);
export const CancelRequest = challengeMutation(Schema.Record(Schema.String, Schema.Never));
export type Mutation<A> = {
  readonly principalId: string;
  readonly projectId: string;
  readonly key: string;
  readonly input: A;
  readonly requestId: string;
};
export type ChallengeMutation<A> = Mutation<A> & { readonly challengeId: string };
export class Router extends Context.Service<
  Router,
  {
    readonly create: (request: Mutation<CreateInput>) => Effect.Effect<CreateResult, DomainError>;
    readonly status: (
      projectId: string,
      id: string,
      principalId: string,
    ) => Effect.Effect<StatusResult, DomainError>;
    readonly verify: (
      request: ChallengeMutation<VerifyInput>,
    ) => Effect.Effect<VerifyResult, DomainError>;
    readonly deliver: (
      request: ChallengeMutation<DeliveryInput>,
    ) => Effect.Effect<SendResult, DomainError>;
    readonly cancel: (
      request: ChallengeMutation<Record<string, never>>,
    ) => Effect.Effect<StatusResult, DomainError>;
  }
>()("otp-router/Router") {}
