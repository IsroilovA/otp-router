import { createServer, type Server } from "node:http";
import { Effect, Fiber, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { makeEngineLayer, EngineControl, engineMetrics } from "@otp-router/engine";
import {
  ApplicationConfigurationError,
  loadConfiguration,
  type ConfigurationInput,
  type Settings,
} from "./config/config.js";
import { makeHttpApiLayer } from "./http/transport.js";
import { WebhooksLive } from "./http/webhook-service.js";
const healthServer = (config: Settings, ready: () => boolean, makeServer: () => Server) =>
  Effect.gen(function* () {
    const engine = yield* EngineControl;
    const scope = yield* Effect.scope;
    const probe = Effect.gen(function* () {
      const fiber = yield* Effect.forkIn(engine.probe, scope);
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
          if (!ready())
            return yield* Effect.fail(new ApplicationConfigurationError({ reason: "not_ready" }));
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
        engineMetrics.pipe(
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
export const serveApplication = (config: Effect.Success<ReturnType<typeof loadConfiguration>>) =>
  Effect.gen(function* () {
    const engine = yield* EngineControl;
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
        ? yield* engine.startWorkers({
            concurrency: config.settings.workerConcurrency,
            shutdownGraceMs: config.settings.shutdownGraceMs,
          })
        : { isRunning: () => true, interrupt: () => {}, stopClaims: Effect.void };
    let accepting = true;
    if (config.settings.role !== "worker") {
      const api = makeHttpApiLayer({ apiKeys: config.settings.apiKeys }).pipe(
        HttpRouter.provideRequest(WebhooksLive),
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
  });
// The caller supplies platform services, scope, and process lifecycle.
export const makeApplication = (entry: ConfigurationInput) =>
  Effect.gen(function* () {
    const config = yield* loadConfiguration(entry);
    const resources = yield* Layer.build(
      makeEngineLayer({ configuration: config.engine, databaseUrl: config.settings.databaseUrl }),
    );
    return yield* serveApplication(config).pipe(Effect.provide(resources));
  });
