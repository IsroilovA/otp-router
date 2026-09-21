import { createHash } from "node:crypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import {
  InvalidRecipient,
  ProviderConfigurationRejected,
  ProviderContractVersion,
  ProviderInstance,
  UnknownProviderOutcome,
  type ProviderDefinition,
  type ProviderSendError,
  type ProviderSendInput,
  type ReadyProvider,
  type SendAccepted,
} from "./contract.js";
import {
  readyMetadata,
  decodeUtf8,
  encodeJson,
  makeTemplateResolver,
  parseJson,
  validateSendInput,
  validateTemplate,
  validateTimeout,
  validateProviderConfiguration,
  validateAllTemplates,
} from "./internal.js";
import { fetchTransport, type HttpTransport } from "./transport.js";

const PlayMobileConfigurationSchema = Schema.Struct({
  username: Schema.RedactedFromValue(Schema.NonEmptyString),
  password: Schema.RedactedFromValue(Schema.NonEmptyString),
  originator: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(11))),
  endpoint: Schema.String.pipe(Schema.check(Schema.isPattern(/^https:\/\//))).pipe(
    Schema.withDecodingDefaultType(Effect.succeed("https://send.smsxabar.uz/broker-api/send")),
  ),
});
export type PlayMobileConfiguration = typeof PlayMobileConfigurationSchema.Type;

const validTextTemplate = (text: string): boolean => {
  const placeholders = [...text.matchAll(/\{\{[^{}]+\}\}/gu)].map((match) => match[0]);
  return (
    placeholders.length === 1 &&
    placeholders[0] === "{{code}}" &&
    fitsSingleSms(text.replace("{{code}}", "00000000"))
  );
};

export const PlayMobileTemplateSchema = Schema.Struct({
  text: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter(validTextTemplate, {
        message:
          "Expected one {{code}} placeholder and a single SMS segment with an eight-digit code",
      }),
    ),
  ),
});
export type PlayMobileTemplate = typeof PlayMobileTemplateSchema.Type;

const PlayMobileErrorSchema = Schema.Struct({ error_code: Schema.String });

const constraints = {
  minCodeLength: 6,
  maxCodeLength: 8,
  minDeliveryWindowMs: 1_000,
} as const;

const gsmBasic = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const gsmExtension = new Set("^{}\\[~]|€");

export const fitsSingleSms = (text: string): boolean => {
  let septets = 0;
  for (const character of text) {
    if (gsmBasic.has(character)) septets += 1;
    else if (gsmExtension.has(character)) septets += 2;
    else return text.length <= 70;
  }
  return septets <= 160;
};

const messageId = (attemptId: string): string =>
  `otp${createHash("sha256").update(attemptId, "utf8").digest("hex").slice(0, 17)}`;

const mapErrorCode = (code: string): ProviderSendError => {
  if (code === "100") {
    return new UnknownProviderOutcome({
      acceptance: "unknown",
      diagnosticCode: "play_mobile_internal_error",
    });
  }
  if (code === "102") {
    return new ProviderConfigurationRejected({
      acceptance: "not_accepted",
      diagnosticCode: "account_locked",
    });
  }
  if (code === "202" || code === "204") {
    return new InvalidRecipient({
      acceptance: "not_accepted",
      diagnosticCode: "recipient_rejected",
    });
  }
  return new UnknownProviderOutcome({
    acceptance: "unknown",
    diagnosticCode: "unknown_provider_error",
  });
};

const send = (
  transport: HttpTransport,
  config: PlayMobileConfiguration,
  input: ProviderSendInput,
): Effect.Effect<SendAccepted, ProviderSendError> =>
  Effect.gen(function* () {
    yield* validateSendInput(input, constraints);
    const template = yield* validateTemplate(PlayMobileTemplateSchema, input.template);
    const text = template.text.replace("{{code}}", input.code);
    if (!fitsSingleSms(text)) {
      return yield* new UnknownProviderOutcome({
        acceptance: "not_accepted",
        diagnosticCode: "message_exceeds_single_segment",
      });
    }
    const ttl = Math.floor(input.remainingDeliveryMs / 1000);
    if (ttl < 1)
      return yield* new UnknownProviderOutcome({
        acceptance: "not_accepted",
        diagnosticCode: "delivery_window_too_short",
      });
    const requestId = messageId(input.attemptId);
    const body: Schema.Json = {
      messages: [
        {
          recipient: input.recipient.slice(1),
          "message-id": requestId,
          sms: {
            ttl,
            originator: config.originator,
            content: { text },
          },
        },
      ],
    };
    const credentials = Buffer.from(
      `${Redacted.value(config.username)}:${Redacted.value(config.password)}`,
      "utf8",
    ).toString("base64");
    const response = yield* transport
      .execute({
        url: config.endpoint,
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type": "application/json; charset=utf-8",
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
    if (response.status === 200) {
      const responseText = yield* decodeUtf8(response.body);
      if (responseText.trim() !== "Request is received") {
        return yield* new UnknownProviderOutcome({
          acceptance: "unknown",
          diagnosticCode: "invalid_provider_response",
        });
      }
      return {
        providerRequestId: requestId,
      };
    }
    const json = yield* parseJson(response.body);
    const parsed = yield* Schema.decodeUnknownEffect(PlayMobileErrorSchema)(json).pipe(
      Effect.mapError(
        () =>
          new UnknownProviderOutcome({
            acceptance: "unknown",
            diagnosticCode: "play_mobile_rejected_unknown",
          }),
      ),
    );
    return yield* mapErrorCode(parsed.error_code);
  });

const metadata = {
  id: "play-mobile-http",
  version: "1.0.0",
  contractVersion: ProviderContractVersion,
  channel: "sms",
  constraints,
  defaultSendTimeoutMs: 10_000,
  diagnosticCodes: [
    "account_locked",
    "delivery_window_too_short",
    "invalid_provider_response",
    "invalid_template_snapshot",
    "message_exceeds_single_segment",
    "play_mobile_internal_error",
    "play_mobile_rejected_unknown",
    "recipient_rejected",
    "transport_failure",
    "unknown_provider_error",
    "unsupported_code_length",
  ],
  idempotency: { supported: false },
} as const;

export const makePlayMobileDefinition = (
  transport: HttpTransport = fetchTransport,
): ProviderDefinition<PlayMobileConfiguration, typeof PlayMobileConfigurationSchema.Encoded> => ({
  ...metadata,
  configSchema: PlayMobileConfigurationSchema,
  templateSchema: PlayMobileTemplateSchema,
  make: (options) =>
    Layer.effect(
      ProviderInstance,
      Effect.gen(function* () {
        yield* validateProviderConfiguration(PlayMobileConfigurationSchema, options.config);
        const sendTimeoutMs = yield* validateTimeout(
          options.sendTimeoutMs,
          metadata.defaultSendTimeoutMs,
        );
        yield* validateAllTemplates(PlayMobileTemplateSchema, options.templates);
        const ready: ReadyProvider = {
          ...readyMetadata(metadata, options, sendTimeoutMs),
          resolveTemplate: makeTemplateResolver(PlayMobileTemplateSchema, options.templates),
          send: (input) => send(transport, options.config, input),
        };
        return ready;
      }),
    ),
});

export const PlayMobileProvider = makePlayMobileDefinition();
