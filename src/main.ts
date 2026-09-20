#!/usr/bin/env node
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HttpApiBuilder, HttpRouter, HttpServerResponse } from "@effect/platform";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { SqlClient } from "@effect/sql";
import { Cause, Effect, Layer, Logger, Schema } from "effect";
import {
  ConfigurationError,
  loadConfiguration,
  RouterConfig,
  type Configuration,
  type Settings,
} from "./config/config.js";
import { validateStoredKeys, validateDeploymentIdentity } from "./database/compatibility.js";
import { DatabaseLive } from "./database/client.js";
import { DatabaseMigrationsLive } from "./database/migrations.js";
import { RouterLive } from "./challenges/service.js";
import { invalidateRestoredChallenges } from "./challenges/cleanup.js";
import { QueueLive } from "./queue/client.js";
import { initializeQueues } from "./queue/jobs.js";
import { openApiDocument } from "./http/api.js";
import { makeHttpApiLayer, httpResponseMiddleware } from "./http/transport.js";
import { WebhooksLive } from "./worker/webhooks.js";
import { prometheus } from "./diagnostics/metrics.js";
import { startWorkers } from "./worker/run.js";

const ConfigModule = Schema.Struct({
  default: Schema.declare(
    (value: unknown): value is Configuration =>
      typeof value === "object" && value !== null && "settings" in value && "providers" in value,
  ),
});
const loadEntry = Effect.gen(function* () {
  const index = process.argv.indexOf("--config"),
    path = process.argv[index + 1];
  if (index < 0 || path === undefined)
    return yield* Effect.dieMessage("Supply --config /path/to/router.config.ts");
  const module: unknown = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(resolve(path)).href),
    catch: () => new ConfigurationError({ reason: "configuration_module_failed" }),
  }).pipe(Effect.orDie);
  return (yield* Schema.decodeUnknown(ConfigModule)(module)).default;
});
const healthServer = (config: Settings, ready: () => boolean, makeServer: () => Server) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const app = HttpRouter.empty.pipe(
      HttpRouter.get("/health/live", HttpServerResponse.json({ status: "ok" })),
      HttpRouter.get(
        "/health/ready",
        Effect.gen(function* () {
          if (!ready()) return yield* Effect.fail(new ConfigurationError({ reason: "not_ready" }));
          return yield* sql`SELECT 1`;
        }).pipe(
          Effect.timeout("2 seconds"),
          Effect.matchEffect({
            onFailure: () => HttpServerResponse.json({ status: "unavailable" }, { status: 503 }),
            onSuccess: () => HttpServerResponse.json({ status: "ok" }),
          }),
        ),
      ),
      HttpRouter.get(
        "/metrics",
        prometheus.pipe(
          Effect.map((text) => HttpServerResponse.text(text, { contentType: "text/plain" })),
        ),
      ),
    );
    yield* Layer.build(
      importHttpServer.serve(app).pipe(
        Layer.provide(
          NodeHttpServer.layer(makeServer, {
            port: config.internalPort,
            host: config.internalHost,
          }),
        ),
      ),
    );
  });
import { HttpServer as importHttpServer } from "@effect/platform";
const serve = Effect.gen(function* () {
  if (process.argv.includes("--openapi")) {
    yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(openApiDocument, null, 2)}\n`));
    return;
  }
  const entry = yield* loadEntry;
  const config = yield* loadConfiguration(entry);
  if (process.argv.includes("--check-config")) {
    yield* Effect.logInfo("configuration_valid");
    return;
  }
  const infrastructure = DatabaseLive.pipe(
    Layer.tap((context) => DatabaseMigrationsLive.pipe(Layer.build, Effect.provide(context))),
    Layer.provideMerge(NodeContext.layer),
  );
  const database = yield* Layer.build(infrastructure);
  yield* Effect.gen(function* () {
    if (process.argv.includes("--invalidate-restored")) {
      let count = yield* invalidateRestoredChallenges;
      while (count > 0) count = yield* invalidateRestoredChallenges;
      yield* Effect.logInfo(
        "restored_challenges_invalidated_keep_traffic_stopped_until_quota_reconciliation",
      );
      return;
    }
    yield* validateStoredKeys(config.settings);
    yield* validateDeploymentIdentity(
      config.settings,
      process.argv.includes("--adopt-recipient-key"),
    );
    if (process.argv.includes("--adopt-recipient-key")) {
      yield* Effect.logInfo("recipient_key_identity_adopted");
      return;
    }
    const queue = yield* Layer.build(QueueLive);
    yield* Effect.gen(function* () {
      yield* initializeQueues;
      if (process.argv.includes("--check-schema")) {
        yield* Effect.logInfo("schemas_compatible");
        return;
      }
      const servers: Server[] = [];
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          clearTimeout(shutdownTimer);
        }),
      );
      const makeServer = () => {
        const server = createServer();
        servers.push(server);
        return server;
      };
      const worker =
        config.settings.role !== "api"
          ? yield* startWorkers
          : { isRunning: () => true, interrupt: () => {}, stopClaims: Effect.void };
      let accepting = true;
      if (config.settings.role !== "worker") {
        const dependencies = Layer.merge(RouterLive, WebhooksLive);
        const api = makeHttpApiLayer({ apiKeys: config.settings.apiKeys }).pipe(
          Layer.provide(dependencies),
        );
        const http = HttpApiBuilder.serve(httpResponseMiddleware).pipe(
          Layer.provide(api),
          Layer.provide(
            NodeHttpServer.layer(makeServer, {
              port: config.settings.port,
              host: config.settings.host,
            }),
          ),
        );
        yield* Layer.build(http);
      }
      yield* healthServer(config.settings, () => accepting && worker.isRunning(), makeServer);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          accepting = false;
          shutdownTimer = setTimeout(() => {
            for (const server of servers) server.closeAllConnections();
            worker.interrupt();
          }, config.settings.shutdownGraceMs);
        }).pipe(Effect.zipRight(worker.stopClaims), Effect.orDie),
      );
      yield* Effect.logInfo("router_ready");
      return yield* Effect.never;
    }).pipe(Effect.provide(queue), Effect.provideService(RouterConfig, config));
  }).pipe(Effect.provide(database));
}).pipe(
  Effect.scoped,
  Effect.provide(Layer.merge(NodeContext.layer, Logger.json)),
  Effect.catchAllCause((cause) =>
    Cause.isInterruptedOnly(cause)
      ? Effect.void
      : Effect.logError("router_startup_or_runtime_failure").pipe(
          Effect.zipRight(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
  ),
);
NodeRuntime.runMain(serve, { disableErrorReporting: true });
