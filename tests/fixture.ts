import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { NodeServices } from "@effect/platform-node";
import { SqlClient } from "effect/unstable/sql";
import { PgClient } from "@effect/sql-pg";
import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect";
import type { PgBoss } from "pg-boss";
import { Router, type OperationResult } from "../src/challenges/contracts.js";
import { RouterLive } from "../src/challenges/service.js";
import {
  RouterConfig,
  loadConfiguration,
  type Configuration,
  type RuntimeConfiguration,
} from "../src/config/config.js";
import { DatabaseLive } from "../src/database/client.js";
import { DatabaseMigrationsLive } from "../src/database/migrations.js";
import { Queue, QueueLive } from "../src/queue/client.js";
import { initializeQueues } from "../src/queue/jobs.js";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

const command = (executable: string, args: readonly string[]): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    execFile(executable, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const removeContainer = async (name: string): Promise<void> => {
  try {
    await command("docker", ["rm", "--force", name]);
  } catch {
    // A failed startup can remove the --rm container before cleanup runs.
  }
};

const waitUntilReady = async (name: string): Promise<void> => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await command("docker", [
        "exec",
        name,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "otp_router_test",
      ]);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("PostgreSQL did not become ready");
};

const mappedPort = async (name: string): Promise<number> => {
  const { stdout } = await command("docker", ["port", name, "5432/tcp"]);
  const match = /:(\d+)\s*$/u.exec(stdout.trim().split("\n")[0] ?? "");
  const port = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Docker returned an invalid PostgreSQL port");
  }
  return port;
};

const portAcceptsConnections = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });

const waitForMappedPort = async (port: number): Promise<void> => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await portAcceptsConnections(port)) return;
    await delay(100);
  }
  throw new Error("The mapped PostgreSQL port did not become reachable");
};

export interface PostgresFixture {
  readonly containerName: string;
  readonly databaseUrl: string;
  readonly close: () => Promise<void>;
}

export const startPostgres = async (): Promise<PostgresFixture> => {
  const containerName = `otp-router-test-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await command("docker", [
      "run",
      "--rm",
      "--detach",
      "--publish",
      "127.0.0.1::5432",
      "--name",
      containerName,
      "--env",
      "POSTGRES_PASSWORD=integration-secret",
      "--env",
      "POSTGRES_DB=otp_router_test",
      "postgres:17-alpine",
    ]);
    await waitUntilReady(containerName);
    const port = await mappedPort(containerName);
    await waitForMappedPort(port);
    return {
      containerName,
      databaseUrl: `postgres://postgres:integration-secret@127.0.0.1:${String(port)}/otp_router_test`,
      close: () => removeContainer(containerName),
    };
  } catch (error) {
    await removeContainer(containerName);
    throw error;
  }
};

export interface IntegrationRuntime {
  readonly configuration: RuntimeConfiguration;
  readonly pg: Context.Service.Shape<typeof PgClient.PgClient>;
  readonly queue: PgBoss;
  readonly router: Context.Service.Shape<typeof Router>;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, PgClient.PgClient | SqlClient.SqlClient | Queue>,
  ) => Promise<A>;
  readonly reset: () => Promise<void>;
  readonly close: () => Promise<void>;
}

const buildInScope = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
  scope: Scope.Scope,
): Effect.Effect<Context.Context<A>, E, Exclude<R, Scope.Scope>> =>
  Layer.build(layer).pipe(Effect.provideService(Scope.Scope, scope));

export const startRuntime = async (
  databaseUrl: string,
  configuration: Configuration,
): Promise<IntegrationRuntime> => {
  const scope = await Effect.runPromise(Scope.make());
  const configProvider = ConfigProvider.fromUnknown(
    Object.fromEntries([["DATABASE_URL", databaseUrl]]),
  );
  try {
    const databaseContext = await Effect.runPromise(
      buildInScope(
        DatabaseLive.pipe(
          Layer.tap((context) => DatabaseMigrationsLive.pipe(Layer.build, Effect.provide(context))),
          Layer.provide(NodeServices.layer),
        ),
        scope,
      ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, configProvider)),
    );
    const pg = Context.get(databaseContext, PgClient.PgClient);
    const sql = Context.get(databaseContext, SqlClient.SqlClient);
    const queueContext = await Effect.runPromise(
      buildInScope(QueueLive, scope).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      ),
    );
    const queue = Context.get(queueContext, Queue);
    await Effect.runPromise(initializeQueues.pipe(Effect.provideService(Queue, queue)));
    const runtimeConfiguration = await Effect.runPromise(
      loadConfiguration(configuration).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const routerContext = await Effect.runPromise(
      buildInScope(
        RouterLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(RouterConfig, runtimeConfiguration),
              Layer.succeed(PgClient.PgClient, pg),
              Layer.succeed(Queue, queue),
            ),
          ),
        ),
        scope,
      ),
    );
    const router = Context.get(routerContext, Router);
    const run = <A, E>(
      effect: Effect.Effect<A, E, PgClient.PgClient | SqlClient.SqlClient | Queue>,
    ): Promise<A> =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(PgClient.PgClient, pg),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(Queue, queue),
        ),
      );
    const reset = async (): Promise<void> => {
      await queue.deleteAllJobs();
      await run(
        sql.unsafe(
          "TRUNCATE TABLE otp_router.notifications, otp_router.challenge_events, otp_router.callback_inbox, otp_router.provider_correlations, otp_router.provider_restrictions, otp_router.deliveries, otp_router.challenge_secrets, otp_router.idempotency_records, otp_router.quota_events, otp_router.challenges CASCADE",
        ),
      );
    };
    return {
      configuration: runtimeConfiguration,
      pg,
      queue,
      router,
      run,
      reset,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
};

export const challengeIdFrom = (result: OperationResult): string => {
  if (!("challengeId" in result.body)) throw new Error("Expected a challenge result");
  return result.body.challengeId;
};
