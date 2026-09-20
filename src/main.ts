#!/usr/bin/env node
import { replayNotification } from "./delivery/notifications/send.js";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { SqlClient } from "effect/unstable/sql";
import { Cause, Effect, Exit, Fiber, Layer, Logger, Runtime, Schema } from "effect";
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
import { makeHttpApiLayer } from "./http/transport.js";
import { WebhooksLive } from "./http/webhook-service.js";
import { prometheus } from "./diagnostics/metrics.js";
import { startWorkers } from "./worker/run.js";

const startupFailureReason = (cause: Cause.Cause<unknown>): string => {
  const failure: unknown = Cause.squash(cause);
  if (failure instanceof ConfigurationError) return failure.reason;
  const known = Schema.Struct({
    _tag: Schema.Literals([
      "ProviderConfigurationError",
      "TemplateResolutionError",
      "SchemaCompatibilityError",
      "SqlError",
      "QueueLifecycleError",
      "QueueOperationError",
      "SchemaError",
    ]),
  });
  return Schema.is(known)(failure) ? failure._tag : "internal_error";
};

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
    return yield* Effect.die(new Error("Supply --config /path/to/router.config.ts"));
  const module: unknown = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(resolve(path)).href),
    catch: () => new ConfigurationError({ reason: "configuration_module_failed" }),
  }).pipe(Effect.orDie);
  return (yield* Schema.decodeUnknownEffect(ConfigModule)(module)).default;
});
const healthServer = (config: Settings, ready: () => boolean, makeServer: () => Server) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scope = yield* Effect.scope;
    const probe = Effect.gen(function* () {
      const fiber = yield* Effect.forkIn(sql`SELECT 1`, scope);
      // Native PostgreSQL cancellation drains the connection. Keep that cleanup in
      // the server scope without delaying the readiness response past its deadline.
      return yield* Fiber.join(fiber).pipe(
        Effect.timeout("2 seconds"),
        Effect.ensuring(Effect.forkIn(Fiber.interrupt(fiber), scope).pipe(Effect.asVoid)),
      );
    });
    const app = Layer.mergeAll(
      HttpRouter.add("GET", "/health/live", HttpServerResponse.json({ status: "ok" })),
      HttpRouter.add(
        "GET",
        "/health/ready",
        Effect.gen(function* () {
          if (!ready()) return yield* Effect.fail(new ConfigurationError({ reason: "not_ready" }));
          return yield* probe;
        }).pipe(
          Effect.matchEffect({
            onFailure: () => HttpServerResponse.json({ status: "unavailable" }, { status: 503 }),
            onSuccess: () => HttpServerResponse.json({ status: "ok" }),
          }),
        ),
      ),
      HttpRouter.add(
        "GET",
        "/metrics",
        prometheus.pipe(
          Effect.map((text) => HttpServerResponse.text(text, { contentType: "text/plain" })),
        ),
      ),
    );
    yield* Layer.build(
      HttpRouter.serve(app, { disableLogger: true }).pipe(
        Layer.provide(
          NodeHttpServer.layer(makeServer, {
            port: config.internalPort,
            host: config.internalHost,
          }),
        ),
      ),
    );
  });
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
    Layer.provideMerge(NodeServices.layer),
  );
  const database = yield* Layer.build(infrastructure);
  yield* Effect.gen(function* () {
    if (!process.argv.includes("--invalidate-restored")) {
      yield* validateStoredKeys(config.settings);
      yield* validateDeploymentIdentity(
        config.settings,
        process.argv.includes("--adopt-recipient-key"),
      );
    }
    if (process.argv.includes("--adopt-recipient-key")) {
      yield* Effect.logInfo("recipient_key_identity_adopted");
      return;
    }
    const queue = yield* Layer.build(QueueLive);
    yield* Effect.gen(function* () {
      yield* initializeQueues;
      if (process.argv.includes("--invalidate-restored")) {
        let count = yield* invalidateRestoredChallenges(config);
        while (count > 0) count = yield* invalidateRestoredChallenges(config);
        yield* Effect.logInfo(
          "restored_challenges_invalidated_keep_traffic_stopped_until_quota_reconciliation",
        );
        return;
      }

      const replayIndex = process.argv.indexOf("--replay-webhook");
      if (replayIndex >= 0) {
        const eventId = yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(
          process.argv[replayIndex + 1],
        );
        if (config.settings.webhook === undefined)
          return yield* Effect.die(new Error("Configure a webhook destination before replay"));
        const replayed = yield* replayNotification(eventId);
        yield* Effect.logInfo(replayed ? "webhook_replay_queued" : "failed_webhook_not_found");
        return;
      }
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
          HttpRouter.provideRequest(dependencies),
        );
        const http = HttpRouter.serve(api, { disableLogger: true }).pipe(
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
        }).pipe(Effect.andThen(worker.stopClaims), Effect.orDie),
      );
      yield* Effect.logInfo("router_ready");
      return yield* Effect.never;
    }).pipe(Effect.provide(queue), Effect.provideService(RouterConfig, config));
  }).pipe(Effect.provide(database));
}).pipe(
  Effect.scoped,
  Effect.provide(Layer.merge(NodeServices.layer, Logger.layer([Logger.consoleJson]))),
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.logError("router_startup_or_runtime_failure").pipe(
          Effect.annotateLogs("reason", startupFailureReason(cause)),
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
  ),
);
NodeRuntime.runMain(serve, {
  disableErrorReporting: true,
  teardown: (exit, onExit) => {
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) onExit(0);
    else Runtime.defaultTeardown(exit, onExit);
  },
});
