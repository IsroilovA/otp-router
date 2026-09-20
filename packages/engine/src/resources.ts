import type { PgClient } from "@effect/sql-pg";
import { Context, Effect, Layer, type Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { RouterLive } from "./challenges/service.js";
import { invalidateRestoredChallenges } from "./challenges/cleanup.js";
import { RouterConfig } from "./config/runtime.js";
import { type RuntimeConfiguration } from "./config/config.js";
import { makeDatabaseLayer } from "./database/client.js";
import { DatabaseMigrationsLive } from "./database/migrations.js";
import { validateStoredKeys, validateDeploymentIdentity } from "./database/compatibility.js";
import { ProviderCallbacksLive } from "./delivery/provider-callbacks.js";
import { replayNotification } from "./notifications/send.js";
import { makeQueueLayer, type Queue } from "./queue/client.js";
import { initializeQueues } from "./queue/jobs.js";
import { startWorkers } from "./worker/run.js";

const makeControl = Effect.gen(function* () {
  const context = yield* Effect.context<
    PgClient.PgClient | SqlClient.SqlClient | Queue | RouterConfig
  >();
  const config = Context.get(context, RouterConfig);
  const sql = Context.get(context, SqlClient.SqlClient);
  return {
    probe: sql`SELECT 1`.pipe(Effect.asVoid),
    startWorkers: (options: Parameters<typeof startWorkers>[0]) =>
      startWorkers(options).pipe(Effect.provide(context)),
    replayNotification: (eventId: string) =>
      replayNotification(eventId).pipe(Effect.provide(context)),
    invalidateRestoredChallenges: Effect.gen(function* () {
      while ((yield* invalidateRestoredChallenges(config)) > 0) {}
    }).pipe(Effect.provide(context)),
  };
});
export class EngineControl extends Context.Service<
  EngineControl,
  Effect.Success<typeof makeControl>
>()("otp-router/EngineControl") {}

// All resources belong to the caller's scope. Importing the package starts no work.
// The single URL binds both pools; transactional enqueue still uses the current SQL transaction.
export const makeEngineLayer = (options: {
  readonly databaseUrl: Redacted.Redacted<string>;
  readonly configuration: RuntimeConfiguration;
  readonly identityMode?: "validate" | "restore" | "adopt-recipient-key";
}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const database = yield* Layer.build(
        makeDatabaseLayer(options.databaseUrl).pipe(
          Layer.tap((context) => DatabaseMigrationsLive.pipe(Layer.build, Effect.provide(context))),
        ),
      );
      if (options.identityMode !== "restore") {
        yield* validateStoredKeys(options.configuration.settings).pipe(Effect.provide(database));
        yield* validateDeploymentIdentity(
          options.configuration.settings,
          options.identityMode === "adopt-recipient-key",
        ).pipe(Effect.provide(database));
      }
      const queue = yield* Layer.build(makeQueueLayer(options.databaseUrl));
      yield* initializeQueues.pipe(Effect.provide(queue));
      const dependencies = Layer.succeedContext(
        Context.merge(database, queue).pipe(Context.add(RouterConfig, options.configuration)),
      );
      return yield* Layer.build(
        Layer.mergeAll(
          RouterLive,
          ProviderCallbacksLive,
          Layer.effect(EngineControl, makeControl),
        ).pipe(Layer.provide(dependencies)),
      );
    }),
  );
