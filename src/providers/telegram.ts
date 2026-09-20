import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import {
  CallbackAuthenticationError,
  CallbackFormatError,
  ProviderConfigurationRejected,
  ProviderContractVersion,
  ProviderInstance,
  UnknownProviderOutcome,
  type CallbackInput,
  type CallbackResult,
  type JsonValue,
  type NormalizedDeliveryEvent,
  type ProviderDefinition,
  type ProviderSendError,
  type ProviderSendInput,
  type ReadyProvider,
  type SendAccepted,
} from "./contract.js";
import {
  callbackTimestamp,
  readyMetadata,
  decodeUtf8,
  encodeJson,
  parseJson,
  resolveNoTemplate,
  validateSendInput,
  validateTimeout,
  validateProviderConfiguration,
} from "./internal.js";
import { fetchTransport, type HttpTransport } from "./transport.js";

const TelegramConfigurationSchema = Schema.Struct({
  apiToken: Schema.Redacted(Schema.NonEmptyString),
  senderUsername: Schema.optional(Schema.NonEmptyString),
  callbackUrl: Schema.optional(Schema.String.pipe(Schema.pattern(/^https:\/\//))),
  callbackMaxAgeSeconds: Schema.optionalWith(Schema.Int.pipe(Schema.between(30, 3_600)), {
    default: () => 300,
  }),
});
export type TelegramConfiguration = typeof TelegramConfigurationSchema.Type;

const TelegramSuccessSchema = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({ request_id: Schema.NonEmptyString }),
});
const TelegramErrorSchema = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.NonEmptyString,
});
const TelegramResponseSchema = Schema.Union(TelegramSuccessSchema, TelegramErrorSchema);

const TelegramCallbackSchema = Schema.Struct({
  request_id: Schema.NonEmptyString,
  payload: Schema.optional(Schema.NonEmptyString),
  delivery_status: Schema.Struct({
    status: Schema.Literal("sent", "delivered", "read", "expired", "revoked"),
    updated_at: Schema.Int,
  }),
});

const constraints = {
  minCodeLength: 4,
  maxCodeLength: 8,
  minDeliveryWindowMs: 30_000,
} as const;

const getHeader = (input: CallbackInput, name: string): string | undefined => {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(input.headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
};

const constantTimeHexEqual = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]+$/iu.test(left) || !/^[0-9a-f]+$/iu.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const authenticateCallback = (
  input: CallbackInput,
  config: TelegramConfiguration,
): Effect.Effect<void, CallbackAuthenticationError> => {
  const timestamp = getHeader(input, "x-request-timestamp");
  const signature = getHeader(input, "x-request-signature");
  if (timestamp === undefined || signature === undefined) {
    return Effect.fail(
      new CallbackAuthenticationError({ diagnosticCode: "missing_authentication" }),
    );
  }
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isInteger(timestampSeconds) ||
    Math.abs(Date.now() / 1_000 - timestampSeconds) > config.callbackMaxAgeSeconds
  ) {
    return Effect.fail(new CallbackAuthenticationError({ diagnosticCode: "stale_request" }));
  }
  const key = createHash("sha256").update(Redacted.value(config.apiToken), "utf8").digest();
  const expected = createHmac("sha256", key)
    .update(timestamp, "utf8")
    .update("\n", "utf8")
    .update(input.body)
    .digest("hex");
  return constantTimeHexEqual(signature, expected)
    ? Effect.void
    : Effect.fail(new CallbackAuthenticationError({ diagnosticCode: "invalid_signature" }));
};

const normalizeStatus = (
  status: "sent" | "delivered" | "read" | "expired" | "revoked",
): NormalizedDeliveryEvent["status"] => {
  switch (status) {
    case "delivered":
    case "read":
      return "delivered";
    case "expired":
      return "failed";
    case "revoked":
      return "cancelled";
    case "sent":
      return "accepted";
  }
};

const callbackEvent = (
  input: CallbackInput,
  config: TelegramConfiguration,
): Effect.Effect<CallbackResult, CallbackAuthenticationError | CallbackFormatError> =>
  Effect.gen(function* () {
    if (input.body.byteLength > 64 * 1024) {
      return yield* new CallbackFormatError({ diagnosticCode: "batch_too_large" });
    }
    yield* authenticateCallback(input, config);
    const text = yield* decodeUtf8(input.body).pipe(
      Effect.mapError(() => new CallbackFormatError({ diagnosticCode: "invalid_body" })),
    );
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => new CallbackFormatError({ diagnosticCode: "invalid_body" }),
    });
    const report = yield* Schema.decodeUnknown(TelegramCallbackSchema)(json).pipe(
      Effect.mapError(() => new CallbackFormatError({ diagnosticCode: "invalid_body" })),
    );
    const status = report.delivery_status.status;
    const providerEventTime = yield* callbackTimestamp(report.delivery_status.updated_at);
    const event: NormalizedDeliveryEvent = {
      deduplicationKey: `${report.request_id}:${status}:${String(report.delivery_status.updated_at)}`,
      correlationReference: report.payload ?? report.request_id,
      status: normalizeStatus(status),
      providerEventTime,
      ...(status === "expired" ? { diagnosticCode: "expired" } : {}),
    };
    return { _tag: "Events", events: [event] };
  });

const mapTelegramError = (error: string): ProviderSendError =>
  error === "ACCESS_TOKEN_INVALID"
    ? new ProviderConfigurationRejected({
        acceptance: "not_accepted",
        diagnosticCode: "access_token_invalid",
      })
    : new UnknownProviderOutcome({
        acceptance: "unknown",
        diagnosticCode: "telegram_rejected_unknown",
      });

const send = (
  transport: HttpTransport,
  config: TelegramConfiguration,
  input: ProviderSendInput,
): Effect.Effect<SendAccepted, ProviderSendError> =>
  Effect.gen(function* () {
    yield* validateSendInput(input, constraints);
    const remainingSeconds = Math.floor(input.remainingDeliveryMs / 1_000);
    if (remainingSeconds < 30) {
      return yield* new UnknownProviderOutcome({
        acceptance: "not_accepted",
        diagnosticCode: "delivery_window_too_short",
      });
    }
    const ttl = Math.min(remainingSeconds, 3_600);
    const body: Record<string, JsonValue> = {
      phone_number: input.recipient,
      code: input.code,
      ttl,
      payload: input.deliveryId,
    };
    if (config.senderUsername !== undefined) body["sender_username"] = config.senderUsername;
    if (config.callbackUrl !== undefined) body["callback_url"] = config.callbackUrl;
    const response = yield* transport
      .execute({
        url: "https://gatewayapi.telegram.org/sendVerificationMessage",
        method: "POST",
        headers: {
          authorization: `Bearer ${Redacted.value(config.apiToken)}`,
          "content-type": "application/json",
        },
        body: encodeJson(body),
      })
      .pipe(
        Effect.mapError(
          () =>
            new UnknownProviderOutcome({
              acceptance: "unknown",
              diagnosticCode: "transport_failure",
            }),
        ),
      );
    const json = yield* parseJson(response.body);
    const parsed = yield* Schema.decodeUnknown(TelegramResponseSchema)(json).pipe(
      Effect.mapError(
        () =>
          new UnknownProviderOutcome({
            acceptance: "unknown",
            diagnosticCode: "invalid_provider_response",
          }),
      ),
    );
    if (!parsed.ok) return yield* mapTelegramError(parsed.error);
    return {
      providerRequestId: parsed.result.request_id,
      acceptanceEvidence: "telegram_ok",
    };
  });

const metadata = {
  id: "telegram-gateway",
  version: "1.0.0",
  contractVersion: ProviderContractVersion,
  channel: "telegram",
  constraints,
  defaultSendTimeoutMs: 10_000,
  diagnosticCodes: [
    "access_token_invalid",
    "delivery_window_too_short",
    "expired",
    "invalid_provider_response",
    "telegram_rejected_unknown",
    "transport_failure",
    "unsupported_code_length",
  ],
  idempotency: { supported: false },
} as const;

export const makeTelegramDefinition = (
  transport: HttpTransport = fetchTransport,
): ProviderDefinition<TelegramConfiguration, typeof TelegramConfigurationSchema.Encoded> => ({
  ...metadata,
  configSchema: TelegramConfigurationSchema,
  templateSchema: null,
  make: (options) =>
    Layer.effect(
      ProviderInstance,
      Effect.gen(function* () {
        yield* validateProviderConfiguration(TelegramConfigurationSchema, options.config);
        const sendTimeoutMs = yield* validateTimeout(
          options.sendTimeoutMs,
          metadata.defaultSendTimeoutMs,
        );
        const ready: ReadyProvider = {
          ...readyMetadata(metadata, options, sendTimeoutMs),
          resolveTemplate: resolveNoTemplate,
          send: (input) => send(transport, options.config, input),
          callback: (input) => callbackEvent(input, options.config),
        };
        return ready;
      }),
    ),
});

export const TelegramProvider = makeTelegramDefinition();
