import { count } from "../diagnostics/metrics.js";
import { SqlClient } from "effect/unstable/sql";
import { Effect, Layer } from "effect";
import { RouterConfig } from "../config/config.js";
import { ingestEvents } from "../delivery/callbacks.js";
import {
  WebhookError,
  WebhookHandler,
  type WebhookHandshakeInput,
  type WebhookIngestInput,
} from "./webhooks.js";
import { Queue } from "../queue/client.js";
import type { CallbackInput } from "../providers/contract.js";

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
    const config = yield* RouterConfig,
      sql = yield* SqlClient.SqlClient,
      queue = yield* Queue;
    const decode = (input: WebhookHandshakeInput | WebhookIngestInput) =>
      Effect.gen(function* () {
        const provider = config.providers.get(input.providerInstanceId);
        if (provider?.callback === undefined)
          return yield* Effect.fail(new WebhookError({ code: "unknown_instance" }));
        return yield* provider.callback(callbackInput(input)).pipe(
          Effect.tapError((error) =>
            count(
              "callback",
              error._tag === "CallbackAuthenticationError" ? "authentication_failed" : "invalid",
            ),
          ),
          Effect.mapError(
            (error) =>
              new WebhookError({
                code: error._tag === "CallbackAuthenticationError" ? "unauthorized" : "invalid",
              }),
          ),
        );
      });
    return {
      handshake: (input) =>
        decode(input).pipe(
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
        Effect.gen(function* () {
          const result = yield* decode(input);
          if (result._tag !== "Events")
            return yield* Effect.fail(new WebhookError({ code: "invalid" }));
          yield* ingestEvents(config, input.providerInstanceId, result.events).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(Queue, queue),
            Effect.mapError(() => new WebhookError({ code: "temporarily_unavailable" })),
          );
          yield* count("callback", "ingested");
        }),
    };
  }),
);
