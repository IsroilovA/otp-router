import { PgClient } from "@effect/sql-pg";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { assertCapabilities } from "../config/deployment.js";
import { RouterConfig } from "../config/runtime.js";
import { rows } from "../database/query.js";
import { transaction } from "../database/transaction.js";
import { count } from "../diagnostics/metrics.js";
import { canonical } from "../crypto.js";
import type {
  CallbackError,
  CallbackInput,
  CallbackResult,
  NormalizedDeliveryEvent,
} from "../providers/contract.js";
import { Queue } from "../queue/client.js";
import { ResourceData } from "../runtime/contracts.js";
import { secretVersion } from "../runtime/providers.js";
import { resource } from "../runtime/store.js";
import { ingestEvents, type CallbackEvidence } from "./callbacks.js";
import { DeliveryOwner } from "./owner.js";
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
    const owner = yield* DeliveryOwner;
    const pg = yield* PgClient.PgClient;
    const config = yield* RouterConfig,
      sql = yield* SqlClient.SqlClient,
      queue = yield* Queue;
    const authenticate = (input: ProviderCallbackRequest) =>
      transaction(
        Effect.gen(function* () {
          yield* assertCapabilities(config);
          const instance = yield* resource("instance", input.providerInstanceId);
          if (instance.data.kind !== "instance")
            return yield* Effect.fail(new ProviderCallbackError({ code: "unknown_instance" }));
          const account = yield* resource("account", instance.data.accountId);
          const versions = yield* rows(
            Schema.Struct({ id: Schema.String }),
            sql`SELECT id FROM otp_router.account_secret_versions WHERE account_id = ${account.id} AND purpose = 'callback' AND NOT revoked AND ciphertext IS NOT NULL ORDER BY created_at DESC`,
          );
          const revisions = yield* rows(
            Schema.Struct({ revision: Schema.Int, data: ResourceData }),
            sql`SELECT revision,data FROM otp_router.runtime_revisions WHERE kind = 'instance' AND resource_id = ${instance.id} ORDER BY revision DESC`,
          );
          if (account.data.kind !== "account")
            return yield* Effect.die(new Error("Invalid account"));
          const adapter = config.adapters.get(account.data.adapterId);
          if (adapter === undefined)
            return yield* Effect.fail(new ProviderCallbackError({ code: "unknown_instance" }));
          const candidates = [];
          for (const version of versions) {
            const callbackSecrets = yield* secretVersion(
              config,
              account.id,
              "callback",
              version.id,
            );
            for (const revision of revisions) {
              if (revision.data.kind !== "instance") continue;
              const callback = yield* adapter.makeCallback({
                identity: account.data.identity,
                execution: revision.data.settings.execution,
                callbackSecrets,
              });
              if (callback !== undefined)
                candidates.push({ revision: revision.revision, callback });
            }
          }
          if (candidates.length === 0 && versions.length > 0)
            return yield* Effect.fail(new ProviderCallbackError({ code: "unknown_instance" }));
          return yield* decodeCandidates(input.callback, candidates);
        }),
      ).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((error) =>
          error instanceof ProviderCallbackError
            ? error
            : new ProviderCallbackError({
                code:
                  error._tag === "DomainError" && error.code === "resource_not_found"
                    ? "unknown_instance"
                    : "temporarily_unavailable",
              }),
        ),
      );
    return {
      decode: (input) => authenticate(input).pipe(Effect.map(({ result }) => result)),
      ingest: (input) =>
        Effect.gen(function* () {
          const { result, events } = yield* authenticate(input);
          if (result._tag !== "Events")
            return yield* Effect.fail(new ProviderCallbackError({ code: "invalid" }));
          yield* ingestEvents(config, input.providerInstanceId, events).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(Queue, queue),
            Effect.provideService(PgClient.PgClient, pg),
            Effect.provideService(DeliveryOwner, owner),
            Effect.mapError(() => new ProviderCallbackError({ code: "temporarily_unavailable" })),
          );
          yield* count("callback", "ingested");
        }),
    };
  }),
);

const decodeCandidates = (
  input: CallbackInput,
  candidates: readonly {
    readonly revision: number;
    readonly callback: (input: CallbackInput) => Effect.Effect<CallbackResult, CallbackError>;
  }[],
) =>
  Effect.gen(function* () {
    const evidence = new Map<
      string,
      { readonly event: NormalizedDeliveryEvent; readonly revisions: Set<number> }
    >();
    let handshake: Extract<CallbackResult, { _tag: "Handshake" }> | undefined;
    let authenticated = false;
    let invalid = false;
    for (const candidate of candidates) {
      const decoded = yield* candidate.callback(input).pipe(
        Effect.map((result) => ({ status: "matched" as const, result })),
        Effect.catchTag("CallbackAuthenticationError", () =>
          Effect.succeed({ status: "unauthorized" as const }),
        ),
        Effect.catchTag("CallbackFormatError", () =>
          Effect.succeed({ status: "invalid" as const }),
        ),
      );
      if (decoded.status !== "matched") {
        invalid ||= decoded.status === "invalid";
        continue;
      }
      authenticated = true;
      if (decoded.result._tag === "Handshake") {
        handshake ??= decoded.result;
        continue;
      }
      for (const event of decoded.result.events) {
        const key = canonical(event);
        const match = evidence.get(key) ?? { event, revisions: new Set<number>() };
        match.revisions.add(candidate.revision);
        evidence.set(key, match);
      }
    }
    if (!authenticated)
      return yield* Effect.fail(
        new ProviderCallbackError({ code: invalid ? "invalid" : "unauthorized" }),
      );
    const events: readonly CallbackEvidence[] = [...evidence.values()].map(
      ({ event, revisions }) => ({ ...event, instanceRevisions: [...revisions] }),
    );
    const result: CallbackResult = handshake ?? {
      _tag: "Events",
      events: [...evidence.values()].map(({ event }) => event),
    };
    return { result, events };
  });
