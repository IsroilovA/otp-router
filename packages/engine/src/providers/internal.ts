import { Effect, Schema } from "effect";
import {
  CallbackFormatError,
  IsoDateTimeSchema,
  type ProviderDefinition,
  type ProviderMakeOptions,
  ProviderConfigurationError,
  TemplateResolutionError,
  ProviderUncertain,
  ProviderRejected,
  type Locale,
  type ProviderConstraints,
  type ProviderSendInput,
  type ResolvedTemplate,
} from "./contract.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const encodeJson = (value: Schema.Json): Uint8Array => encoder.encode(JSON.stringify(value));

export const decodeUtf8 = (body: Uint8Array): Effect.Effect<string, ProviderUncertain> =>
  Effect.try({
    try: () => decoder.decode(body),
    catch: () =>
      new ProviderUncertain({
        diagnosticCode: "invalid_provider_response",
      }),
  });

export const parseJson = (body: Uint8Array): Effect.Effect<unknown, ProviderUncertain> =>
  decodeUtf8(body).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () =>
          new ProviderUncertain({
            diagnosticCode: "invalid_provider_response",
          }),
      }),
    ),
  );

export const validateSendInput = (
  input: ProviderSendInput,
  constraints: ProviderConstraints,
): Effect.Effect<void, ProviderRejected> => {
  if (
    input.code.length < constraints.minCodeLength ||
    input.code.length > constraints.maxCodeLength
  ) {
    return Effect.fail(
      new ProviderRejected({
        reason: "configuration",
        diagnosticCode: "unsupported_code_length",
      }),
    );
  }
  return Effect.void;
};

export const validateTimeout = (
  sendTimeoutMs: number | undefined,
  defaultSendTimeoutMs: number,
): Effect.Effect<number, ProviderConfigurationError> => {
  const timeout = sendTimeoutMs ?? defaultSendTimeoutMs;
  return Number.isSafeInteger(defaultSendTimeoutMs) &&
    defaultSendTimeoutMs > 0 &&
    Number.isSafeInteger(timeout) &&
    timeout > 0
    ? Effect.succeed(timeout)
    : Effect.fail(new ProviderConfigurationError({ diagnosticCode: "invalid_send_timeout" }));
};

export const resolveNoTemplate = (
  candidates: readonly Locale[],
): Effect.Effect<ResolvedTemplate, TemplateResolutionError> => {
  const locale = candidates[0];
  return locale === undefined
    ? Effect.fail(new TemplateResolutionError({ diagnosticCode: "missing_template" }))
    : Effect.succeed({ locale, template: null });
};

export const makeTemplateResolver = <Template extends Schema.Json, Encoded>(
  schema: Schema.Codec<Template, Encoded>,
  templates: Readonly<Record<string, unknown>>,
): ((
  candidates: readonly Locale[],
) => Effect.Effect<ResolvedTemplate, TemplateResolutionError>) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (candidates) => {
    const match = candidates.find((candidate) => Object.hasOwn(templates, candidate));
    if (match === undefined) {
      return Effect.fail(new TemplateResolutionError({ diagnosticCode: "missing_template" }));
    }
    return decode(templates[match], { onExcessProperty: "error" }).pipe(
      Effect.map((template) => ({ locale: match, template })),
      Effect.mapError(() => new TemplateResolutionError({ diagnosticCode: "invalid_template" })),
    );
  };
};

export const validateTemplate = <Template extends Schema.Json, Encoded>(
  schema: Schema.Codec<Template, Encoded>,
  template: Schema.Json,
): Effect.Effect<Template, ProviderRejected> =>
  Schema.decodeUnknownEffect(schema)(template).pipe(
    Effect.mapError(
      () =>
        new ProviderRejected({
          reason: "configuration",
          diagnosticCode: "invalid_template_snapshot",
        }),
    ),
  );

export const validateProviderConfiguration = <A, I>(schema: Schema.Codec<A, I>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      () => new ProviderConfigurationError({ diagnosticCode: "invalid_configuration" }),
    ),
  );
export const validateAllTemplates = <A, I>(
  schema: Schema.Codec<A, I>,
  templates: Readonly<Record<string, unknown>>,
) =>
  Effect.forEach(
    Object.values(templates),
    (value) =>
      Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
        Effect.mapError(
          () => new ProviderConfigurationError({ diagnosticCode: "invalid_template" }),
        ),
      ),
    { discard: true },
  );

export const readyMetadata = (
  definition: Omit<ProviderDefinition, "make" | "makeCallback" | "templateSchema">,
  options: Pick<ProviderMakeOptions, "instanceId" | "revision">,
  sendTimeoutMs: number,
) => ({
  instanceId: options.instanceId,
  pluginId: definition.id,
  version: definition.version,
  contractVersion: definition.contractVersion,
  channel: definition.channel,
  revision: options.revision,
  constraints: definition.constraints,
  defaultSendTimeoutMs: definition.defaultSendTimeoutMs,
  sendTimeoutMs,
  diagnosticCodes: definition.diagnosticCodes,
  idempotency: definition.idempotency,
});

export const callbackTimestamp = (seconds: number) =>
  Effect.try({
    try: () => new Date(seconds * 1000).toISOString(),
    catch: () => new CallbackFormatError({ diagnosticCode: "invalid_body" }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(IsoDateTimeSchema)),
    Effect.mapError(() => new CallbackFormatError({ diagnosticCode: "invalid_body" })),
  );

export const getHeader = (
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined => {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
};
