import { Effect, Schema } from "effect";
import { type RoutingSelector, SelectorFailure } from "@otp-router/engine/config";
import {
  ProviderContractVersion,
  defineProvider,
  type ProviderSendInput,
  type SendAccepted,
} from "@otp-router/engine/providers";

const TextConfigurationSchema = Schema.Struct({ prefix: Schema.String });
type TextConfiguration = typeof TextConfigurationSchema.Type;

const metadata = {
  id: "example-text-sink",
  version: "1.0.0",
  contractVersion: ProviderContractVersion,
  channel: "text-sink",
  constraints: { minCodeLength: 6, maxCodeLength: 8, minDeliveryWindowMs: 0 },
  defaultSendTimeoutMs: 1_000,
  diagnosticCodes: [],
  idempotency: { supported: false },
} as const;

const send = (config: TextConfiguration, input: ProviderSendInput): Effect.Effect<SendAccepted> =>
  Effect.sync(() => {
    void `${config.prefix}${input.code}`;
    return {
      providerRequestId: `text:${input.attemptId}`,
    };
  });

export const TextProvider = defineProvider({
  ...metadata,
  configSchema: TextConfigurationSchema,
  templateSchema: null,
  create: (config) => ({ send: (input) => send(config, input) }),
});

export const textSelector: RoutingSelector = ({ recipient }) =>
  recipient.startsWith("+")
    ? Effect.succeed({ _tag: "Route", providerInstanceIds: ["text-primary"] })
    : Effect.fail(new SelectorFailure());
