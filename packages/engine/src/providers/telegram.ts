import { defineProvider } from "./define.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Effect, Redacted, Schema } from "effect";
import {
  AttemptIdSchema,
  CallbackAuthenticationError,
  CallbackFormatError,
  ProviderContractVersion,
  ProviderUncertain,
  ProviderRejected,
  type CallbackInput,
  type CallbackResult,
  type NormalizedDeliveryEvent,
  type ProviderDefinition,
  type ProviderSendError,
  type ProviderSendInput,
  type SendAccepted,
} from "./contract.js";
import {
  callbackTimestamp,
  getHeader,
  decodeUtf8,
  encodeJson,
  parseJson,
  resolveNoTemplate,
  validateTemplate,
  validateSendInput,
} from "./internal.js";
import { fetchTransport, type HttpTransport } from "./transport.js";

const TelegramDeliverySettingsSchema = Schema.Struct({
  deliveryTtlSeconds: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 30, maximum: 3_600 })),
  ),
});

const TelegramConfigurationSchema = Schema.Struct({
  deliveryTtlSeconds: TelegramDeliverySettingsSchema.fields.deliveryTtlSeconds.pipe(
    Schema.withDecodingDefaultType(Effect.succeed(60)),
  ),
  apiToken: Schema.RedactedFromValue(Schema.NonEmptyString),
  senderUsername: Schema.optional(Schema.NonEmptyString),
  callbackUrl: Schema.optional(Schema.String.pipe(Schema.check(Schema.isPattern(/^https:\/\//)))),
  callbackMaxAgeSeconds: Schema.Int.pipe(
    Schema.check(Schema.isBetween({ minimum: 30, maximum: 3_600 })),
  ).pipe(Schema.withDecodingDefaultType(Effect.succeed(300))),
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
const TelegramResponseSchema = Schema.Union([TelegramSuccessSchema, TelegramErrorSchema]);

const TelegramCallbackSchema = Schema.Struct({
  request_id: Schema.NonEmptyString,
  payload: Schema.optional(AttemptIdSchema),
  delivery_status: Schema.Struct({
    status: Schema.Literals(["sent", "delivered", "read", "expired", "revoked"]),
    updated_at: Schema.Int,
  }),
});

const constraints = {
  minCodeLength: 4,
  maxCodeLength: 8,
  minDeliveryWindowMs: 30_000,
} as const;

const constantTimeHexEqual = (provided: string, expected: string): boolean => {
  if (!/^[0-9a-f]{64}$/iu.test(provided)) return false;
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
};

const authenticateCallback = (
  input: CallbackInput,
  config: TelegramConfiguration,
): Effect.Effect<void, CallbackAuthenticationError> => {
  const timestamp = getHeader(input.headers, "x-request-timestamp");
  const signature = getHeader(input.headers, "x-request-signature");
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
    const report = yield* Schema.decodeUnknownEffect(TelegramCallbackSchema)(json).pipe(
      Effect.mapError(() => new CallbackFormatError({ diagnosticCode: "invalid_body" })),
    );
    const status = report.delivery_status.status;
    const providerEventTime = yield* callbackTimestamp(report.delivery_status.updated_at);
    const event: NormalizedDeliveryEvent = {
      deduplicationKey: `${report.request_id}:${status}:${String(report.delivery_status.updated_at)}`,
      correlationReference:
        report.payload === undefined
          ? { _tag: "ProviderRequest", providerRequestId: report.request_id }
          : { _tag: "Attempt", attemptId: report.payload },
      providerRequestId: report.request_id,
      status: normalizeStatus(status),
      providerEventTime,
      ...(status === "expired" ? { diagnosticCode: "expired" } : {}),
    };
    return { _tag: "Events", events: [event] };
  });

// Gateway defines ok:false as an unsuccessful API request. The error name refines
// the reason, not that rejection evidence. An existing send is the exception.
// https://core.telegram.org/gateway/verification-tutorial#sending-auth-codes
const mapTelegramError = (error: string): ProviderSendError => {
  switch (error) {
    case "ACCESS_TOKEN_INVALID":
      return new ProviderRejected({
        reason: "configuration",
        diagnosticCode: "access_token_invalid",
      });
    // Observed Gateway names: https://github.com/apifonica/tg-gateway-go/blob/main/errors.go
    // These describe Telegram reachability, never a globally invalid recipient.
    case "PHONE_NUMBER_NOT_FOUND":
    case "PHONE_NUMBER_NOT_AVAILABLE":
      return new ProviderRejected({
        reason: "recipient_unavailable",
        diagnosticCode: "telegram_recipient_unavailable",
      });
    case "MESSAGE_ALREADY_SENT":
      return new ProviderUncertain({ diagnosticCode: "telegram_already_sent" });
    default:
      return new ProviderRejected({ reason: "unspecified", diagnosticCode: "telegram_rejected" });
  }
};

const send = (
  transport: HttpTransport,
  config: TelegramConfiguration,
  input: ProviderSendInput,
): Effect.Effect<SendAccepted, ProviderSendError> =>
  Effect.gen(function* () {
    yield* validateSendInput(input, constraints);
    const settings = yield* validateTemplate(TelegramDeliverySettingsSchema, input.template);
    const remainingSeconds = Math.floor(input.remainingDeliveryMs / 1_000);
    if (remainingSeconds < 30) {
      return yield* new ProviderRejected({
        reason: "configuration",
        diagnosticCode: "delivery_window_too_short",
      });
    }
    const ttl = Math.min(remainingSeconds, settings.deliveryTtlSeconds);
    const body: Record<string, Schema.Json> = {
      phone_number: input.recipient,
      code: input.code,
      ttl,
      payload: input.attemptId,
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
            new ProviderUncertain({
              diagnosticCode: "transport_failure",
            }),
        ),
      );
    // A server/proxy failure or HTTP timeout is not an application rejection,
    // even when its body resembles the Gateway error envelope.
    const successfulHttp = response.status >= 200 && response.status < 300;
    const clientErrorHttp =
      response.status >= 400 && response.status < 500 && response.status !== 408;
    if (!successfulHttp && !clientErrorHttp)
      return yield* new ProviderUncertain({ diagnosticCode: "unexpected_http_status" });
    const json = yield* parseJson(response.body);
    const parsed = yield* Schema.decodeUnknownEffect(TelegramResponseSchema)(json).pipe(
      Effect.mapError(
        () =>
          new ProviderUncertain({
            diagnosticCode: "invalid_provider_response",
          }),
      ),
    );
    if (!parsed.ok) return yield* mapTelegramError(parsed.error);
    if (!successfulHttp)
      return yield* new ProviderUncertain({ diagnosticCode: "invalid_provider_response" });
    return {
      providerRequestId: parsed.result.request_id,
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
    "invalid_template_snapshot",
    "telegram_rejected",
    "telegram_recipient_unavailable",
    "telegram_already_sent",
    "unexpected_http_status",
    "transport_failure",
    "unsupported_code_length",
  ],
  idempotency: { supported: false },
} as const;

export const makeTelegramDefinition = (
  transport: HttpTransport = fetchTransport,
): ProviderDefinition<TelegramConfiguration, typeof TelegramConfigurationSchema.Encoded> =>
  defineProvider({
    ...metadata,
    configSchema: TelegramConfigurationSchema,
    templateSchema: null,
    create: (config) => ({
      resolveTemplate: (candidates) =>
        resolveNoTemplate(candidates).pipe(
          Effect.map(({ locale }) => ({
            locale,
            template: { deliveryTtlSeconds: config.deliveryTtlSeconds },
          })),
        ),
      send: (input) => send(transport, config, input),
      callback: (input) => callbackEvent(input, config),
    }),
  });

export const TelegramProvider = makeTelegramDefinition();
