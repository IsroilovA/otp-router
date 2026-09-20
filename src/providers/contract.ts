import { Context, Data, Schema } from "effect";
import type { Effect, Layer } from "effect";

export const ProviderContractVersion = 1 as const;

export const ProviderInstanceIdSchema = Schema.NonEmptyString.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{1,64}$/),
  Schema.brand("ProviderInstanceId"),
);
export type ProviderInstanceId = typeof ProviderInstanceIdSchema.Type;

export const ChallengeIdSchema = Schema.UUID.pipe(Schema.brand("ChallengeId"));
export type ChallengeId = typeof ChallengeIdSchema.Type;

export const DeliveryIdSchema = Schema.UUID.pipe(Schema.brand("DeliveryId"));
export type DeliveryId = typeof DeliveryIdSchema.Type;

export const NormalizedPhoneSchema = Schema.String.pipe(
  Schema.pattern(/^\+[1-9][0-9]{6,14}$/),
  Schema.brand("NormalizedPhone"),
);
export type NormalizedPhone = typeof NormalizedPhoneSchema.Type;

export const OtpCodeSchema = Schema.String.pipe(
  Schema.pattern(/^[0-9]{4,8}$/),
  Schema.brand("OtpCode"),
);
export type OtpCode = typeof OtpCodeSchema.Type;

export const IsoDateTimeSchema = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u),
  Schema.filter((value) => !Number.isNaN(Date.parse(value)), {
    message: () => "Expected an ISO date-time string",
  }),
  Schema.brand("IsoDateTime"),
);
export type IsoDateTime = typeof IsoDateTimeSchema.Type;

export const LocaleSchema = Schema.NonEmptyString.pipe(Schema.maxLength(64));
export type Locale = typeof LocaleSchema.Type;

export type JsonValue = null | boolean | number | string | JsonArray | JsonObject;
export interface JsonArray extends ReadonlyArray<JsonValue> {}
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type AcceptanceCertainty = "not_accepted" | "unknown";

interface ProviderFailureFields {
  readonly acceptance: AcceptanceCertainty;
  readonly diagnosticCode: string;
  readonly retryAt?: IsoDateTime;
}

export class RecipientUnavailable extends Data.TaggedError(
  "RecipientUnavailable",
)<ProviderFailureFields> {}
export class InvalidRecipient extends Data.TaggedError("InvalidRecipient")<ProviderFailureFields> {}
export class ProviderThrottled extends Data.TaggedError(
  "ProviderThrottled",
)<ProviderFailureFields> {}
export class ProviderConfigurationRejected extends Data.TaggedError(
  "ProviderConfigurationRejected",
)<ProviderFailureFields> {}
export class TemporaryProviderFailure extends Data.TaggedError(
  "TemporaryProviderFailure",
)<ProviderFailureFields> {}
export class UnknownProviderOutcome extends Data.TaggedError(
  "UnknownProviderOutcome",
)<ProviderFailureFields> {}

export type ProviderSendError =
  | RecipientUnavailable
  | InvalidRecipient
  | ProviderThrottled
  | ProviderConfigurationRejected
  | TemporaryProviderFailure
  | UnknownProviderOutcome;

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
  readonly keyScope?: string;
  readonly retention?: string;
  readonly deduplicationEvidence?: string;
}

export interface ResolvedTemplate {
  readonly locale: Locale;
  readonly template: JsonValue;
}

export interface ProviderSendInput {
  readonly challengeId: ChallengeId;
  readonly deliveryId: DeliveryId;
  readonly recipient: NormalizedPhone;
  readonly code: OtpCode;
  readonly expiresAt: IsoDateTime;
  readonly remainingDeliveryMs: number;
  readonly locale: Locale;
  readonly template: JsonValue;
  readonly providerIdempotencyKey?: string;
}

export interface NormalizedDeliveryEvent {
  readonly deduplicationKey: string;
  readonly correlationReference: string;
  readonly status: "accepted" | "delivered" | "failed" | "cancelled";
  readonly providerEventTime?: IsoDateTime;
  readonly diagnosticCode?: string;
}

export interface SendAccepted {
  readonly providerRequestId?: string;
  readonly acceptanceEvidence: string;
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
  readonly enabled: boolean;
  readonly settingsFingerprint: string;
  readonly constraints: ProviderConstraints;
  readonly sendTimeoutMs: number;
  readonly defaultSendTimeoutMs: number;
  readonly diagnosticCodes: readonly string[];
  readonly idempotency: ProviderIdempotency;
  readonly resolveTemplate: (
    localeCandidates: readonly Locale[],
  ) => Effect.Effect<ResolvedTemplate, TemplateResolutionError>;
  readonly send: (input: ProviderSendInput) => Effect.Effect<SendAccepted, ProviderSendError>;
  readonly callback?: (input: CallbackInput) => Effect.Effect<CallbackResult, CallbackError>;
}

export class ProviderInstance extends Context.Tag("otp-router/ProviderInstance")<
  ProviderInstance,
  ReadyProvider
>() {}

export interface ProviderMakeOptions<Configuration> {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly settingsFingerprint: string;
  readonly sendTimeoutMs?: number;
  readonly config: Configuration;
  readonly templates: Readonly<Record<string, unknown>>;
}

export interface ProviderDefinition<Configuration, EncodedConfiguration = Configuration> {
  readonly id: string;
  readonly version: string;
  readonly contractVersion: typeof ProviderContractVersion;
  readonly channel: string;
  readonly configSchema: Schema.Schema<Configuration, EncodedConfiguration>;
  readonly templateSchema: Schema.Schema.AnyNoContext | null;
  readonly constraints: ProviderConstraints;
  readonly defaultSendTimeoutMs: number;
  readonly diagnosticCodes: readonly string[];
  readonly idempotency: ProviderIdempotency;
  readonly make: (
    options: ProviderMakeOptions<Configuration>,
  ) => Layer.Layer<ProviderInstance, ProviderConfigurationError>;
}
