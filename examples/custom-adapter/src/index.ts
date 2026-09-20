import { Effect, Layer, Schema } from "effect";
import { type RoutingSelector, SelectorFailure } from "otp-router/config";
import {
  type NormalizedPhone,
  ProviderContractVersion,
  type ProviderDefinition,
  ProviderInstance,
  type ProviderSendInput,
  type SendAccepted,
  TemplateResolutionError,
} from "otp-router/providers";

const TextConfigurationSchema = Schema.Struct({ prefix: Schema.String });
type TextConfiguration = typeof TextConfigurationSchema.Type;

const constraints = {
  minCodeLength: 6,
  maxCodeLength: 8,
  minDeliveryWindowMs: 0,
} as const;

const send = (config: TextConfiguration, input: ProviderSendInput): Effect.Effect<SendAccepted> =>
  Effect.sync(() => {
    void `${config.prefix}${input.code}`;
    return {
      providerRequestId: `text:${input.deliveryId}`,
      acceptanceEvidence: "custom_text_sink",
    };
  });

export const TextProvider: ProviderDefinition<
  TextConfiguration,
  typeof TextConfigurationSchema.Encoded
> = {
  id: "example-text-sink",
  version: "1.0.0",
  contractVersion: ProviderContractVersion,
  channel: "text-sink",
  configSchema: TextConfigurationSchema,
  templateSchema: null,
  constraints,
  defaultSendTimeoutMs: 1_000,
  idempotency: { supported: false },
  make: (options) =>
    Layer.succeed(ProviderInstance, {
      instanceId: options.instanceId,
      pluginId: "example-text-sink",
      version: "1.0.0",
      contractVersion: ProviderContractVersion,
      channel: "text-sink",
      enabled: options.enabled,
      settingsFingerprint: options.settingsFingerprint,
      constraints,
      sendTimeoutMs: options.sendTimeoutMs ?? 1_000,
      defaultSendTimeoutMs: 1_000,
      idempotency: { supported: false },
      resolveTemplate: (locales) => {
        const locale = locales[0];
        return locale === undefined
          ? Effect.fail(new TemplateResolutionError({ diagnosticCode: "missing_template" }))
          : Effect.succeed({ locale, template: {} });
      },
      send: (input) => send(options.config, input),
    }),
};

export const textSelector: RoutingSelector = ({ recipient }) =>
  recipient.startsWith("+")
    ? Effect.succeed({ _tag: "Route", providerInstanceIds: ["text-primary"] })
    : Effect.fail(new SelectorFailure());

export const normalizeForExample = (phone: NormalizedPhone): string => phone;
