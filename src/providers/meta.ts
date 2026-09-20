import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import {
  CallbackAuthenticationError,
  CallbackFormatError,
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
  makeTemplateResolver,
  parseJson,
  validateSendInput,
  validateTemplate,
  validateTimeout,
  validateProviderConfiguration,
  validateAllTemplates,
} from "./internal.js";
import { fetchTransport, type HttpTransport } from "./transport.js";

const MetaConfigurationSchema = Schema.Struct({
  accessToken: Schema.Redacted(Schema.NonEmptyString),
  appSecret: Schema.Redacted(Schema.NonEmptyString),
  verifyToken: Schema.Redacted(Schema.NonEmptyString),
  phoneNumberId: Schema.String.pipe(Schema.pattern(/^[0-9]+$/)),
  apiVersion: Schema.String.pipe(Schema.pattern(/^v[0-9]+\.[0-9]+$/)),
});
export type MetaConfiguration = typeof MetaConfigurationSchema.Type;

export const MetaTemplateSchema = Schema.Struct({
  name: Schema.NonEmptyString.pipe(Schema.maxLength(512)),
  languageCode: Schema.NonEmptyString.pipe(Schema.maxLength(32)),
  codeButtonIndex: Schema.Int.pipe(Schema.between(0, 9)),
});
export type MetaTemplate = typeof MetaTemplateSchema.Type;

const MetaSendResponseSchema = Schema.Struct({
  messages: Schema.Tuple(Schema.Struct({ id: Schema.NonEmptyString })),
});

const MetaStatusSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.Literal("sent", "delivered", "read", "failed", "deleted"),
  timestamp: Schema.String.pipe(Schema.pattern(/^[0-9]+$/)),
});
const MetaCallbackSchema = Schema.Struct({
  object: Schema.Literal("whatsapp_business_account"),
  entry: Schema.Array(
    Schema.Struct({
      changes: Schema.Array(
        Schema.Struct({
          value: Schema.Struct({ statuses: Schema.Array(MetaStatusSchema) }),
          field: Schema.Literal("messages"),
        }),
      ),
    }),
  ),
});

const constraints = {
  minCodeLength: 6,
  maxCodeLength: 8,
  minDeliveryWindowMs: 0,
} as const;

const getHeader = (input: CallbackInput, name: string): string | undefined => {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(input.headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
};

const constantTimeSignatureEqual = (provided: string, expectedHex: string): boolean => {
  const match = /^sha256=([0-9a-f]{64})$/iu.exec(provided);
  if (match?.[1] === undefined) return false;
  const left = Buffer.from(match[1], "hex");
  const right = Buffer.from(expectedHex, "hex");
  return timingSafeEqual(left, right);
};

const authenticatePost = (
  input: CallbackInput,
  config: MetaConfiguration,
): Effect.Effect<void, CallbackAuthenticationError> => {
  const signature = getHeader(input, "x-hub-signature-256");
  if (signature === undefined) {
    return Effect.fail(
      new CallbackAuthenticationError({ diagnosticCode: "missing_authentication" }),
    );
  }
  const expected = createHmac("sha256", Redacted.value(config.appSecret))
    .update(input.body)
    .digest("hex");
  return constantTimeSignatureEqual(signature, expected)
    ? Effect.void
    : Effect.fail(new CallbackAuthenticationError({ diagnosticCode: "invalid_signature" }));
};

const normalizeStatus = (
  status: "sent" | "delivered" | "read" | "failed" | "deleted",
): NormalizedDeliveryEvent["status"] => {
  switch (status) {
    case "delivered":
    case "read":
      return "delivered";
    case "failed":
      return "failed";
    case "deleted":
      return "cancelled";
    case "sent":
      return "accepted";
  }
};

const decodeMetaEvents = (
  input: CallbackInput,
  config: MetaConfiguration,
): Effect.Effect<CallbackResult, CallbackAuthenticationError | CallbackFormatError> =>
  Effect.gen(function* () {
    if (input.body.byteLength > 256 * 1024) {
      return yield* new CallbackFormatError({ diagnosticCode: "batch_too_large" });
    }
    yield* authenticatePost(input, config);
    const text = yield* decodeUtf8(input.body).pipe(
      Effect.mapError(() => new CallbackFormatError({ diagnosticCode: "invalid_body" })),
    );
    const value = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => new CallbackFormatError({ diagnosticCode: "invalid_body" }),
    });
    const callback = yield* Schema.decodeUnknown(MetaCallbackSchema)(value).pipe(
      Effect.mapError(() => new CallbackFormatError({ diagnosticCode: "invalid_body" })),
    );
    const statuses = callback.entry.flatMap((entry) =>
      entry.changes.flatMap((change) => change.value.statuses),
    );
    if (statuses.length === 0) {
      return yield* new CallbackFormatError({ diagnosticCode: "unsupported_event" });
    }
    if (statuses.length > 1_000) {
      return yield* new CallbackFormatError({ diagnosticCode: "batch_too_large" });
    }
    const events: NormalizedDeliveryEvent[] = [];
    for (const status of statuses) {
      const seconds = Number(status.timestamp);
      if (!Number.isSafeInteger(seconds)) {
        return yield* new CallbackFormatError({ diagnosticCode: "invalid_body" });
      }
      const providerEventTime = yield* callbackTimestamp(seconds);
      events.push({
        deduplicationKey: `${status.id}:${status.status}:${status.timestamp}`,
        correlationReference: status.id,
        status: normalizeStatus(status.status),
        providerEventTime,
        ...(status.status === "failed" ? { diagnosticCode: "meta_delivery_failed" } : {}),
      });
    }
    return { _tag: "Events", events };
  });

const callback = (
  input: CallbackInput,
  config: MetaConfiguration,
): Effect.Effect<CallbackResult, CallbackAuthenticationError | CallbackFormatError> => {
  if (input.method === "GET") {
    const mode = input.query["hub.mode"];
    const token = input.query["hub.verify_token"];
    const challenge = input.query["hub.challenge"];
    if (mode !== "subscribe" || token === undefined || challenge === undefined) {
      return Effect.fail(
        new CallbackAuthenticationError({ diagnosticCode: "missing_authentication" }),
      );
    }
    const expected = Buffer.from(Redacted.value(config.verifyToken), "utf8");
    const provided = Buffer.from(token, "utf8");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return Effect.fail(new CallbackAuthenticationError({ diagnosticCode: "invalid_signature" }));
    }
    return Effect.succeed({
      _tag: "Handshake",
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: new TextEncoder().encode(challenge),
    });
  }
  if (input.method !== "POST") {
    return Effect.fail(new CallbackFormatError({ diagnosticCode: "unsupported_event" }));
  }
  return decodeMetaEvents(input, config);
};

const send = (
  transport: HttpTransport,
  config: MetaConfiguration,
  input: ProviderSendInput,
): Effect.Effect<SendAccepted, ProviderSendError> =>
  Effect.gen(function* () {
    yield* validateSendInput(input, constraints);
    const template = yield* validateTemplate(MetaTemplateSchema, input.template);
    const body: JsonValue = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.recipient.slice(1),
      type: "template",
      template: {
        name: template.name,
        language: { code: template.languageCode },
        components: [
          { type: "body", parameters: [{ type: "text", text: input.code }] },
          {
            type: "button",
            sub_type: "url",
            index: String(template.codeButtonIndex),
            parameters: [{ type: "text", text: input.code }],
          },
        ],
      },
    };
    const response = yield* transport
      .execute({
        url: `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`,
        method: "POST",
        headers: {
          authorization: `Bearer ${Redacted.value(config.accessToken)}`,
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
    if (response.status < 200 || response.status >= 300) {
      return yield* new UnknownProviderOutcome({
        acceptance: "unknown",
        diagnosticCode: "meta_rejected_unknown",
      });
    }
    const json = yield* parseJson(response.body);
    const parsed = yield* Schema.decodeUnknown(MetaSendResponseSchema)(json).pipe(
      Effect.mapError(
        () =>
          new UnknownProviderOutcome({
            acceptance: "unknown",
            diagnosticCode: "invalid_provider_response",
          }),
      ),
    );
    return {
      providerRequestId: parsed.messages[0].id,
      acceptanceEvidence: "meta_message_id",
    };
  });

const metadata = {
  id: "meta-whatsapp-cloud",
  version: "1.0.0",
  contractVersion: ProviderContractVersion,
  channel: "whatsapp",
  constraints,
  defaultSendTimeoutMs: 10_000,
  diagnosticCodes: [
    "invalid_provider_response",
    "invalid_template_snapshot",
    "meta_delivery_failed",
    "meta_rejected_unknown",
    "transport_failure",
    "unsupported_code_length",
  ],
  idempotency: { supported: false },
} as const;

export const makeMetaDefinition = (
  transport: HttpTransport = fetchTransport,
): ProviderDefinition<MetaConfiguration, typeof MetaConfigurationSchema.Encoded> => ({
  ...metadata,
  configSchema: MetaConfigurationSchema,
  templateSchema: MetaTemplateSchema,
  make: (options) =>
    Layer.effect(
      ProviderInstance,
      Effect.gen(function* () {
        yield* validateProviderConfiguration(MetaConfigurationSchema, options.config);
        const sendTimeoutMs = yield* validateTimeout(
          options.sendTimeoutMs,
          metadata.defaultSendTimeoutMs,
        );
        yield* validateAllTemplates(MetaTemplateSchema, options.templates);
        const ready: ReadyProvider = {
          ...readyMetadata(metadata, options, sendTimeoutMs),
          resolveTemplate: makeTemplateResolver(MetaTemplateSchema, options.templates),
          send: (input) => send(transport, options.config, input),
          callback: (input) => callback(input, options.config),
        };
        return ready;
      }),
    ),
});

export const MetaProvider = makeMetaDefinition();
