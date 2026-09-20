import { Effect, Layer } from "effect";
import { ProviderCallbacks } from "@otp-router/engine";
import type { CallbackInput } from "@otp-router/engine/providers";
import {
  WebhookError,
  WebhookHandler,
  type WebhookHandshakeInput,
  type WebhookIngestInput,
} from "./webhooks.js";
const callbackInput = (input: WebhookHandshakeInput | WebhookIngestInput): CallbackInput => ({
  body: "body" in input ? input.body : new Uint8Array(),
  method: "body" in input ? "POST" : "GET",
  path: `/webhooks/${input.providerInstanceId}`,
  headers: input.headers,
  query: Object.fromEntries(
    Object.entries(input.query).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ),
});
export const WebhooksLive = Layer.effect(
  WebhookHandler,
  Effect.gen(function* () {
    const callbacks = yield* ProviderCallbacks;
    return {
      handshake: (input) =>
        callbacks
          .decode({ providerInstanceId: input.providerInstanceId, callback: callbackInput(input) })
          .pipe(
            Effect.mapError((error) => new WebhookError({ code: error.code })),
            Effect.flatMap((result) =>
              result._tag === "Handshake"
                ? Effect.succeed({
                    body: result.body,
                    status: result.status,
                    contentType: result.contentType,
                  })
                : Effect.fail(new WebhookError({ code: "invalid" })),
            ),
          ),
      ingest: (input) =>
        callbacks
          .ingest({ providerInstanceId: input.providerInstanceId, callback: callbackInput(input) })
          .pipe(Effect.mapError((error) => new WebhookError({ code: error.code }))),
    };
  }),
);
