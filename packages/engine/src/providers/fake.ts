import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import {
  CallbackAuthenticationError,
  CallbackFormatError,
  InvalidRecipient,
  IsoDateTimeSchema,
  ProviderConfigurationRejected,
  ProviderContractVersion,
  ProviderInstance,
  ProviderThrottled,
  RecipientUnavailable,
  TemporaryProviderFailure,
  UnknownProviderOutcome,
  type CallbackInput,
  type CallbackResult,
  type NormalizedDeliveryEvent,
  type ProviderDefinition,
  type ProviderSendError,
  type ReadyProvider,
  type SendAccepted,
} from "./contract.js";
import {
  readyMetadata,
  decodeUtf8,
  resolveNoTemplate,
  validateSendInput,
  validateTimeout,
  validateProviderConfiguration,
} from "./internal.js";

const FakeOutcomeSchema = Schema.Literals([
  "accepted",
  "recipient_unavailable",
  "invalid_recipient",
  "throttled",
  "configuration_rejected",
  "temporary_rejected",
  "unknown",
  "never",
]);
export type FakeOutcome = typeof FakeOutcomeSchema.Type;

const FakeConfigurationSchema = Schema.Struct({
  outcome: FakeOutcomeSchema,
  callbackSecret: Schema.RedactedFromValue(Schema.NonEmptyString),
});
export type FakeConfiguration = typeof FakeConfigurationSchema.Type;

const FakeCallbackSchema = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      correlationReference: Schema.NonEmptyString,
      status: Schema.Literals(["accepted", "delivered", "failed", "cancelled"]),
      providerEventTime: Schema.optional(IsoDateTimeSchema),
      diagnosticCode: Schema.optional(Schema.NonEmptyString),
    }),
  ),
});

const constraints = {
  minCodeLength: 6,
  maxCodeLength: 8,
  minDeliveryWindowMs: 0,
} as const;

const sendForOutcome = (
  outcome: FakeOutcome,
  providerRequestId: string,
): Effect.Effect<SendAccepted, ProviderSendError> => {
  switch (outcome) {
    case "accepted":
      return Effect.succeed({ providerRequestId });
    case "recipient_unavailable":
      return Effect.fail(
        new RecipientUnavailable({
          acceptance: "not_accepted",
          diagnosticCode: "fake_recipient_unavailable",
        }),
      );
    case "invalid_recipient":
      return Effect.fail(
        new InvalidRecipient({
          acceptance: "not_accepted",
          diagnosticCode: "fake_invalid_recipient",
        }),
      );
    case "throttled":
      return Effect.fail(
        new ProviderThrottled({
          acceptance: "not_accepted",
          diagnosticCode: "fake_throttled",
        }),
      );
    case "configuration_rejected":
      return Effect.fail(
        new ProviderConfigurationRejected({
          acceptance: "not_accepted",
          diagnosticCode: "fake_configuration_rejected",
        }),
      );
    case "temporary_rejected":
      return Effect.fail(
        new TemporaryProviderFailure({
          acceptance: "not_accepted",
          diagnosticCode: "fake_temporary_rejected",
        }),
      );
    case "unknown":
      return Effect.fail(
        new UnknownProviderOutcome({
          acceptance: "unknown",
          diagnosticCode: "fake_unknown",
        }),
      );
    case "never":
      return Effect.never;
  }
};

const decodeCallback = (
  input: CallbackInput,
  secret: string,
): Effect.Effect<CallbackResult, CallbackAuthenticationError | CallbackFormatError> =>
  Effect.gen(function* () {
    if (input.body.byteLength > 64 * 1024) {
      return yield* new CallbackFormatError({ diagnosticCode: "batch_too_large" });
    }
    const signature = Object.entries(input.headers).find(
      ([name]) => name.toLowerCase() === "x-fake-signature",
    )?.[1];
    if (signature === undefined) {
      return yield* new CallbackAuthenticationError({
        diagnosticCode: "missing_authentication",
      });
    }
    const expected = createHmac("sha256", secret).update(input.body).digest();
    const provided = /^[0-9a-f]{64}$/iu.test(signature)
      ? Buffer.from(signature, "hex")
      : Buffer.alloc(0);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return yield* new CallbackAuthenticationError({ diagnosticCode: "invalid_signature" });
    }
    const text = yield* decodeUtf8(input.body).pipe(
      Effect.mapError(() => new CallbackFormatError({ diagnosticCode: "invalid_body" })),
    );
    const value = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => new CallbackFormatError({ diagnosticCode: "invalid_body" }),
    });
    const callback = yield* Schema.decodeUnknownEffect(FakeCallbackSchema)(value).pipe(
      Effect.mapError(() => new CallbackFormatError({ diagnosticCode: "invalid_body" })),
    );
    if (callback.events.length === 0) {
      return yield* new CallbackFormatError({ diagnosticCode: "unsupported_event" });
    }
    const events: readonly NormalizedDeliveryEvent[] = callback.events.map((event) => ({
      deduplicationKey: event.id,
      correlationReference: event.correlationReference,
      status: event.status,
      ...(event.providerEventTime === undefined
        ? {}
        : { providerEventTime: event.providerEventTime }),
      ...(event.diagnosticCode === undefined ? {} : { diagnosticCode: event.diagnosticCode }),
    }));
    return { _tag: "Events", events };
  });

export const signFakeCallback = (secret: string, body: Uint8Array): string =>
  createHmac("sha256", secret).update(body).digest("hex");

const metadata = {
  id: "deterministic-fake",
  version: "1.0.0",
  contractVersion: ProviderContractVersion,
  channel: "fake",
  constraints,
  defaultSendTimeoutMs: 1_000,
  diagnosticCodes: [
    "fake_configuration_rejected",
    "fake_invalid_recipient",
    "fake_recipient_unavailable",
    "fake_temporary_rejected",
    "fake_throttled",
    "fake_unknown",
    "invalid_provider_response",
    "unsupported_code_length",
  ],
  idempotency: { supported: false },
} as const;

export const FakeProvider: ProviderDefinition<
  FakeConfiguration,
  typeof FakeConfigurationSchema.Encoded
> = {
  ...metadata,
  configSchema: FakeConfigurationSchema,
  templateSchema: null,
  make: (options) =>
    Layer.effect(
      ProviderInstance,
      Effect.gen(function* () {
        yield* validateProviderConfiguration(FakeConfigurationSchema, options.config);
        const sendTimeoutMs = yield* validateTimeout(
          options.sendTimeoutMs,
          metadata.defaultSendTimeoutMs,
        );
        const ready: ReadyProvider = {
          ...readyMetadata(metadata, options, sendTimeoutMs),
          resolveTemplate: resolveNoTemplate,
          send: (input) =>
            validateSendInput(input, constraints).pipe(
              Effect.andThen(sendForOutcome(options.config.outcome, `fake:${input.attemptId}`)),
            ),
          callback: (input) => decodeCallback(input, Redacted.value(options.config.callbackSecret)),
        };
        return ready;
      }),
    ),
};
