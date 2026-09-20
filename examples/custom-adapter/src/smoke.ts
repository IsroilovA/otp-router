import { Context, Effect, Layer, Schema } from "effect";
import {
  ChallengeIdSchema,
  DeliveryIdSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  NormalizedPhoneSchema,
  OtpCodeSchema,
  ProviderInstance,
  ProviderInstanceIdSchema,
} from "@otp-router/engine/providers";
import { TextProvider, textSelector } from "./index.js";

const providerId = Schema.decodeUnknownSync(ProviderInstanceIdSchema)("text-primary");
const recipient = Schema.decodeUnknownSync(NormalizedPhoneSchema)("+14155552671");
const challengeId = Schema.decodeUnknownSync(ChallengeIdSchema)(
  "00000000-0000-4000-8000-000000000000",
);
const deliveryId = Schema.decodeUnknownSync(DeliveryIdSchema)(
  "00000000-0000-4000-8000-000000000001",
);
const code = Schema.decodeUnknownSync(OtpCodeSchema)("012345");
const locale = Schema.decodeUnknownSync(LocaleSchema)("en");
const expiresAt = Schema.decodeUnknownSync(IsoDateTimeSchema)("2030-01-01T00:00:00Z");

const run = Effect.scoped(
  Effect.gen(function* () {
    const route = yield* textSelector({
      recipient,
      purpose: "login",
      locale: "en",
      routingContext: {},
    });
    if (route._tag !== "Route" || route.providerInstanceIds[0] !== providerId) {
      return yield* Effect.die(new Error("custom selector did not return its configured route"));
    }
    const context = yield* Layer.build(
      TextProvider.make({
        instanceId: providerId,
        enabled: true,
        settingsFingerprint: "smoke",
        config: { prefix: "OTP " },
        templates: {},
      }),
    );
    const provider = Context.get(context, ProviderInstance);
    const accepted = yield* provider.send({
      challengeId,
      deliveryId,
      recipient,
      code,
      expiresAt,
      remainingDeliveryMs: 60_000,
      locale,
      template: {},
    });
    if (accepted.providerRequestId !== `text:${deliveryId}`) {
      return yield* Effect.die(new Error("custom provider returned an unexpected result"));
    }
    return { selector: route._tag, provider: provider.pluginId } as const;
  }),
);

const result = await Effect.runPromise(run);
process.stdout.write(`${JSON.stringify(result)}\n`);
