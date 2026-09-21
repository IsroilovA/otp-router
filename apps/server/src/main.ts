#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Cause, Effect, Exit, Layer, Logger, Runtime, Schema } from "effect";
import { ConfigurationError } from "@otp-router/engine/config";
import { makeEngineLayer, EngineControl } from "@otp-router/engine";
import {
  ApplicationConfigurationError,
  loadConfiguration,
  type ConfigurationInput,
} from "./config/config.js";
import { openApiDocument } from "./http/api.js";
import { serveApplication } from "./application.js";
const startupFailureReason = (cause: Cause.Cause<unknown>): string => {
  const failure: unknown = Cause.squash(cause);
  if (failure instanceof ConfigurationError || failure instanceof ApplicationConfigurationError)
    return failure.reason;
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
    (value: unknown): value is ConfigurationInput =>
      typeof value === "object" && value !== null && "settings" in value && "engine" in value,
  ),
});
const loadEntry = Effect.gen(function* () {
  const index = process.argv.indexOf("--config"),
    path = process.argv[index + 1];
  if (index < 0 || path === undefined)
    return yield* Effect.die(new Error("Supply --config /path/to/router.config.ts"));
  const module: unknown = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(resolve(path)).href),
    catch: () => new ApplicationConfigurationError({ reason: "configuration_module_failed" }),
  }).pipe(Effect.orDie);
  return (yield* Schema.decodeUnknownEffect(ConfigModule)(module)).default;
});
const serve = Effect.gen(function* () {
  if (process.argv.includes("--openapi")) {
    yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(openApiDocument, null, 2)}\n`));
    return;
  }
  const config = yield* loadConfiguration(yield* loadEntry);
  if (process.argv.includes("--check-config")) {
    yield* Effect.logInfo("configuration_valid");
    return;
  }
  const resources = yield* Layer.build(
    makeEngineLayer({
      configuration: config.engine,
      databaseUrl: config.settings.databaseUrl,
      identityMode: process.argv.includes("--invalidate-restored")
        ? "restore"
        : process.argv.includes("--adopt-recipient-key")
          ? "adopt-recipient-key"
          : "validate",
    }),
  );
  yield* Effect.gen(function* () {
    const engine = yield* EngineControl;
    if (process.argv.includes("--adopt-recipient-key")) {
      yield* Effect.logInfo("recipient_key_identity_adopted");
      return;
    }
    if (process.argv.includes("--invalidate-restored")) {
      yield* engine.invalidateRestoredOperations;
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
      if (config.engine.settings.webhook === undefined)
        return yield* Effect.die(new Error("Configure a webhook destination before replay"));
      const replayed = yield* engine.replayNotification(eventId);
      yield* Effect.logInfo(replayed ? "webhook_replay_queued" : "failed_webhook_not_found");
      return;
    }
    if (process.argv.includes("--check-schema")) {
      yield* Effect.logInfo("schemas_compatible");
      return;
    }
    return yield* serveApplication(config);
  }).pipe(Effect.provide(resources));
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
