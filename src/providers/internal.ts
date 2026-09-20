import { Effect, Schema } from "effect";
import {
  ProviderConfigurationError,
  TemplateResolutionError,
  UnknownProviderOutcome,
  type JsonValue,
  type Locale,
  type ProviderConstraints,
  type ProviderSendInput,
  type ResolvedTemplate,
} from "./contract.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const encodeJson = (value: JsonValue): Uint8Array => encoder.encode(JSON.stringify(value));

export const decodeUtf8 = (body: Uint8Array): Effect.Effect<string, UnknownProviderOutcome> =>
  Effect.try({
    try: () => decoder.decode(body),
    catch: () =>
      new UnknownProviderOutcome({
        acceptance: "unknown",
        diagnosticCode: "invalid_provider_response",
      }),
  });

export const parseJson = (body: Uint8Array): Effect.Effect<unknown, UnknownProviderOutcome> =>
  decodeUtf8(body).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () =>
          new UnknownProviderOutcome({
            acceptance: "unknown",
            diagnosticCode: "invalid_provider_response",
          }),
      }),
    ),
  );

export const validateSendInput = (
  input: ProviderSendInput,
  constraints: ProviderConstraints,
): Effect.Effect<void, UnknownProviderOutcome> => {
  if (
    input.code.length < constraints.minCodeLength ||
    input.code.length > constraints.maxCodeLength
  ) {
    return Effect.fail(
      new UnknownProviderOutcome({
        acceptance: "not_accepted",
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
  return Number.isFinite(defaultSendTimeoutMs) &&
    defaultSendTimeoutMs > 0 &&
    Number.isFinite(timeout) &&
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

export const makeTemplateResolver = <Template extends JsonValue, Encoded>(
  schema: Schema.Schema<Template, Encoded>,
  templates: Readonly<Record<string, unknown>>,
): ((
  candidates: readonly Locale[],
) => Effect.Effect<ResolvedTemplate, TemplateResolutionError>) => {
  const decode = Schema.decodeUnknown(schema);
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

export const validateTemplate = <Template extends JsonValue, Encoded>(
  schema: Schema.Schema<Template, Encoded>,
  template: JsonValue,
): Effect.Effect<Template, UnknownProviderOutcome> =>
  Schema.decodeUnknown(schema)(template).pipe(
    Effect.mapError(
      () =>
        new UnknownProviderOutcome({
          acceptance: "not_accepted",
          diagnosticCode: "invalid_template_snapshot",
        }),
    ),
  );

export const validateProviderConfiguration = <A, I>(schema: Schema.Schema<A, I>, value: A) =>
  Schema.validate(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      () => new ProviderConfigurationError({ diagnosticCode: "invalid_configuration" }),
    ),
  );
export const validateAllTemplates = <A, I>(
  schema: Schema.Schema<A, I>,
  templates: Readonly<Record<string, unknown>>,
) =>
  Effect.forEach(
    Object.values(templates),
    (value) =>
      Schema.decodeUnknown(schema)(value, { onExcessProperty: "error" }).pipe(
        Effect.mapError(
          () => new ProviderConfigurationError({ diagnosticCode: "invalid_template" }),
        ),
      ),
    { discard: true },
  );
