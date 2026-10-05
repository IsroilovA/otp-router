import { Context, Data, Schema } from "effect";
import type { Effect, Layer } from "effect";

export const ProviderContractVersion = 2 as const;

export const ProviderInstanceIdSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
  Schema.brand("ProviderInstanceId"),
);
export type ProviderInstanceId = typeof ProviderInstanceIdSchema.Type;

export const OperationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("OperationId"),
);
export type OperationId = typeof OperationIdSchema.Type;

export const AttemptIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("AttemptId"));
export type AttemptId = typeof AttemptIdSchema.Type;

export const NormalizedPhoneSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\+[1-9][0-9]{6,14}$/)),
  Schema.brand("NormalizedPhone"),
);
export type NormalizedPhone = typeof NormalizedPhoneSchema.Type;

export const OtpCodeSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9]{4,8}$/)),
  Schema.brand("OtpCode"),
);
export type OtpCode = typeof OtpCodeSchema.Type;

export const IsoDateTimeSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u)),
  Schema.check(
    Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)), {
      message: "Expected an ISO date-time string",
    }),
  ),
  Schema.brand("IsoDateTime"),
);
export type IsoDateTime = typeof IsoDateTimeSchema.Type;

export const LocaleSchema = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(64)));
export type Locale = typeof LocaleSchema.Type;

export class ProviderRejected extends Data.TaggedError("ProviderRejected")<{
  readonly reason:
    | "recipient_unavailable"
    | "invalid_recipient"
    | "throttled"
    | "configuration"
    | "temporary"
    | "unspecified";
  readonly diagnosticCode: string;
  readonly retryAt?: IsoDateTime;
}> {}

export class ProviderUncertain extends Data.TaggedError("ProviderUncertain")<{
  readonly diagnosticCode: string;
}> {}

export type ProviderSendError = ProviderRejected | ProviderUncertain;

export const CorrelationReferenceSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Attempt"), attemptId: AttemptIdSchema }),
  Schema.Struct({
    _tag: Schema.Literal("ProviderRequest"),
    providerRequestId: Schema.NonEmptyString,
  }),
]);
export type CorrelationReference = typeof CorrelationReferenceSchema.Type;

export class ProviderConfigurationError extends Data.TaggedError("ProviderConfigurationError")<{
  readonly diagnosticCode: string;
}> {}

export class TemplateResolutionError extends Data.TaggedError("TemplateResolutionError")<{
  readonly diagnosticCode: "invalid_template" | "missing_template";
}> {}

export class CallbackAuthenticationError extends Data.TaggedError("CallbackAuthenticationError")<{
  readonly diagnosticCode: "invalid_signature" | "missing_authentication" | "stale_request";
}> {}

export class CallbackFormatError extends Data.TaggedError("CallbackFormatError")<{
  readonly diagnosticCode: "batch_too_large" | "invalid_body" | "unsupported_event";
}> {}

export type CallbackError = CallbackAuthenticationError | CallbackFormatError;

export interface ProviderConstraints {
  readonly minCodeLength: number;
  readonly maxCodeLength: number;
  readonly minDeliveryWindowMs: number;
}

export interface ProviderIdempotency {
  readonly supported: boolean;
}

export interface ResolvedTemplate {
  readonly locale: Locale;
  readonly template: Schema.Json;
}

export interface ProviderSendInput {
  readonly operationId: OperationId;
  readonly attemptId: AttemptId;
  readonly recipient: NormalizedPhone;
  readonly code: OtpCode;
  readonly expiresAt: IsoDateTime;
  readonly remainingDeliveryMs: number;
  readonly locale: Locale;
  readonly template: Schema.Json;
  readonly providerIdempotencyKey?: string;
}

export interface NormalizedDeliveryEvent {
  readonly deduplicationKey: string;
  readonly correlationReference: CorrelationReference;
  readonly providerRequestId?: string;
  readonly status: "accepted" | "delivered" | "failed" | "cancelled";
  readonly providerEventTime?: IsoDateTime;
  readonly diagnosticCode?: string;
}

export interface SendAccepted {
  readonly providerRequestId?: string;
  readonly deliveryEvent?: NormalizedDeliveryEvent;
}

export interface CallbackInput {
  readonly body: Uint8Array;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
}

export type CallbackResult =
  | { readonly _tag: "Events"; readonly events: readonly NormalizedDeliveryEvent[] }
  | {
      readonly _tag: "Handshake";
      readonly status: number;
      readonly contentType: string;
      readonly body: Uint8Array;
    };

export interface ReadyProvider {
  readonly instanceId: ProviderInstanceId;
  readonly pluginId: string;
  readonly version: string;
  readonly contractVersion: typeof ProviderContractVersion;
  readonly channel: string;
  readonly revision: string;
  readonly constraints: ProviderConstraints;
  readonly sendTimeoutMs: number;
  readonly defaultSendTimeoutMs: number;
  readonly diagnosticCodes: readonly string[];
  readonly idempotency: ProviderIdempotency;
  readonly resolveTemplate: (
    localeCandidates: readonly Locale[],
  ) => Effect.Effect<ResolvedTemplate, TemplateResolutionError>;
  readonly send: (input: ProviderSendInput) => Effect.Effect<SendAccepted, ProviderSendError>;
}

export class ProviderInstance extends Context.Service<ProviderInstance, ReadyProvider>()(
  "otp-router/ProviderInstance",
) {}

export interface ProviderMakeOptions {
  readonly instanceId: ProviderInstanceId;
  readonly revision: string;
  readonly sendTimeoutMs?: number;
  readonly identity: unknown;
  readonly secrets: unknown;
  readonly execution: unknown;
  readonly templates: Readonly<Record<string, unknown>>;
}

export interface ProviderDefinition {
  readonly id: string;
  readonly version: string;
  readonly contractVersion: typeof ProviderContractVersion;
  readonly schemaVersion: string;
  readonly channel: string;
  readonly identitySchema: Schema.Codec<unknown, unknown>;
  readonly secretsSchema: Schema.Codec<unknown, unknown>;
  readonly callbackSecretsSchema: Schema.Codec<unknown, unknown>;
  readonly executionSchema: Schema.Codec<unknown, unknown>;
  readonly templateSchema: Schema.Codec<unknown, unknown> | null;
  readonly constraints: ProviderConstraints;
  readonly defaultSendTimeoutMs: number;
  readonly diagnosticCodes: readonly string[];
  readonly idempotency: ProviderIdempotency;
  readonly makeCallback: (options: {
    readonly identity: unknown;
    readonly callbackSecrets: unknown;
    readonly execution: unknown;
  }) => Effect.Effect<
    ((input: CallbackInput) => Effect.Effect<CallbackResult, CallbackError>) | undefined,
    ProviderConfigurationError
  >;
  readonly make: (
    options: ProviderMakeOptions,
  ) => Layer.Layer<ProviderInstance, ProviderConfigurationError>;
}
