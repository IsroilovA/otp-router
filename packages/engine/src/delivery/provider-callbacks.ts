import { count } from "../diagnostics/metrics.js";
import { SqlClient } from "effect/unstable/sql";
import { Context, Data, Effect, Layer } from "effect";
import { RouterConfig } from "../config/runtime.js";

import { ingestEvents } from "./callbacks.js";
import { Queue } from "../queue/client.js";
import type { CallbackInput, CallbackResult } from "../providers/contract.js";
export interface ProviderCallbackRequest {
  readonly providerInstanceId: string;
  readonly callback: CallbackInput;
}
export class ProviderCallbackError extends Data.TaggedError("ProviderCallbackError")<{
  readonly code: "invalid" | "unauthorized" | "unknown_instance" | "temporarily_unavailable";
}> {}
export class ProviderCallbacks extends Context.Service<
  ProviderCallbacks,
  {
    readonly decode: (
      input: ProviderCallbackRequest,
    ) => Effect.Effect<CallbackResult, ProviderCallbackError>;
    readonly ingest: (input: ProviderCallbackRequest) => Effect.Effect<void, ProviderCallbackError>;
  }
>()("otp-router/ProviderCallbacks") {}
export const ProviderCallbacksLive = Layer.effect(
  ProviderCallbacks,
  Effect.gen(function* () {
    const config = yield* RouterConfig,
      sql = yield* SqlClient.SqlClient,
      queue = yield* Queue;
    const decode = (input: ProviderCallbackRequest) =>
      Effect.gen(function* () {
        const provider = config.providers.get(input.providerInstanceId);
        if (provider?.callback === undefined)
          return yield* Effect.fail(new ProviderCallbackError({ code: "unknown_instance" }));
        return yield* provider.callback(input.callback).pipe(
          Effect.tapError((error) =>
            count(
              "callback",
              error._tag === "CallbackAuthenticationError" ? "authentication_failed" : "invalid",
            ),
          ),
          Effect.mapError(
            (error) =>
              new ProviderCallbackError({
                code: error._tag === "CallbackAuthenticationError" ? "unauthorized" : "invalid",
              }),
          ),
        );
      });
    return {
      decode,
      ingest: (input) =>
        Effect.gen(function* () {
          const result = yield* decode(input);
          if (result._tag !== "Events")
            return yield* Effect.fail(new ProviderCallbackError({ code: "invalid" }));
          yield* ingestEvents(config, input.providerInstanceId, result.events).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(Queue, queue),
            Effect.mapError(() => new ProviderCallbackError({ code: "temporarily_unavailable" })),
          );
          yield* count("callback", "ingested");
        }),
    };
  }),
);
