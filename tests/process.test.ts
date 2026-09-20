import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Deferred, Effect, ManagedRuntime, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { PgBoss } from "pg-boss";
import { Snapshot, VerificationResult } from "../packages/engine/src/challenges/contracts.js";
import { startPostgres, type PostgresFixture } from "./fixture.js";

const API_KEY = "process-api-key-with-at-least-thirty-two-bytes";
const ROOT = resolve(import.meta.dirname, "..");

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

interface CommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

const command = (executable: string, args: ReadonlyArray<string>): Promise<CommandResult> =>
  new Promise((resolveCommand, reject) => {
    execFile(executable, [...args], { cwd: ROOT, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolveCommand({ stderr, stdout });
    });
  });

const reservePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a TCP port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolvePort(port);
      });
    });
  });

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface RunningProcess {
  readonly child: ChildProcess;
  readonly exit: Promise<ProcessExit>;
  readonly output: () => string;
}

const startProcess = (
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
): RunningProcess => {
  const child = spawn(process.execPath, [...args], {
    cwd: ROOT,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const exit = new Promise<ProcessExit>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, exit, output: () => output };
};

const stopProcess = async (
  running: RunningProcess | undefined,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> => {
  if (running === undefined || running.child.exitCode !== null) return;
  running.child.kill(signal);
  const stopped = await Promise.race([
    running.exit.then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!stopped) {
    running.child.kill("SIGKILL");
    await running.exit;
  }
};

const waitFor = async (
  description: string,
  predicate: (options: { readonly signal: AbortSignal }) => Promise<boolean>,
  timeoutMilliseconds = 30_000,
): Promise<void> => {
  await expect
    .poll(predicate, {
      message: `Waiting for ${description}`,
      interval: 100,
      timeout: timeoutMilliseconds,
    })
    .toBe(true);
};

const waitForReady = async (port: number, running: RunningProcess): Promise<void> => {
  const controller = new AbortController();
  const exited = running.exit.then(() => "exited" as const);
  try {
    await expect
      .poll(
        ({ signal }) =>
          Promise.race([
            fetch(`http://127.0.0.1:${String(port)}/health/ready`, {
              signal: AbortSignal.any([signal, controller.signal]),
            }).then(
              async (response) => {
                await response.body?.cancel();
                return response.status === 200 ? "ready" : "waiting";
              },
              () => "waiting",
            ),
            exited,
          ]),
        {
          message: "Waiting for process readiness",
          interval: 100,
          timeout: 30_000,
        },
      )
      .not.toBe("waiting");
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(`Router exited before readiness: ${running.output()}`);
    }
  } finally {
    controller.abort();
  }
};

const key = (byte: number): string => Buffer.alloc(32, byte).toString("base64url");

const configSource = (sinkPath: string): string => {
  return `import { appendFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { defineConfig } from "@otp-router/server/config";
import { ProviderContractVersion, ProviderInstance } from "@otp-router/engine/providers";

const sink = ${JSON.stringify(sinkPath)};
const provider = {
  instanceId: "process-fake",
  pluginId: "process-test-fake",
  version: "1.0.0",
  contractVersion: ProviderContractVersion,
  channel: "fake",
  enabled: true,
  settingsFingerprint: "process-fake-v1",
  constraints: { minCodeLength: 6, maxCodeLength: 8, minDeliveryWindowMs: 0 },
  defaultSendTimeoutMs: 1000,
  sendTimeoutMs: 60000,
  diagnosticCodes: [],
  idempotency: { supported: false },
  resolveTemplate: (locales) => Effect.succeed({ locale: locales[0] ?? "en", template: null }),
  send: (input) => Effect.promise(async () => {
    if (process.env.OTP_TEST_BEFORE_SEND === "1") await new Promise(() => {});
    await appendFile(sink, JSON.stringify({ deliveryId: input.deliveryId, code: input.code }) + "\\n", { encoding: "utf8", mode: 0o600 });
    if (process.env.OTP_TEST_BLOCK === "1") await new Promise(() => {});
    return { providerRequestId: "process:" + input.deliveryId };
  }),
};

export default defineConfig({
  engine: {
  settings: {
    crypto: {
      deploymentId: "process-test",
      encryption: { active: "enc-v1", keys: { "enc-v1": ${JSON.stringify(key(1))} } },
      verification: { active: "verify-v1", keys: { "verify-v1": ${JSON.stringify(key(2))} } },
      fingerprint: { active: "fingerprint-v1", keys: { "fingerprint-v1": ${JSON.stringify(key(3))} } },
      recipientKey: ${JSON.stringify(key(4))},
    },
    defaultLocale: "en",
    fallbackLocales: [],
    policies: { default: { providerInstanceIds: ["process-fake"], lifetimeSeconds: 300, resendCooldownSeconds: 30 } },
    purposes: { login: ["default"] },
    deploymentSendLimit15m: 100,
    deploymentSendLimit24h: 1000,
  },
  providers: [Layer.succeed(ProviderInstance, provider)],
  },
  settings: {
    databaseUrl: process.env.DATABASE_URL,
    apiKeys: [${JSON.stringify(API_KEY)}],
    role: process.env.OTP_TEST_ROLE,
    port: Number(process.env.OTP_TEST_PORT),
    internalPort: Number(process.env.OTP_TEST_INTERNAL_PORT),
    host: "127.0.0.1",
    internalHost: "127.0.0.1",
    workerConcurrency: 1,
    shutdownGraceMs: 1000,
  },
});
`;
};

const SinkEntry = Schema.Struct({ deliveryId: Schema.String, code: Schema.String });
type SinkEntry = typeof SinkEntry.Type;

const readSink = async (sinkPath: string): Promise<ReadonlyArray<SinkEntry>> => {
  try {
    const text = await readFile(sinkPath, "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const value: unknown = JSON.parse(line);
        return Schema.decodeUnknownSync(SinkEntry)(value);
      });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
};

const createChallenge = async (
  port: number,
  operationKey: string,
  contextId: string,
  phoneNumber: string,
): Promise<Snapshot> => {
  const response = await fetch(`http://127.0.0.1:${String(port)}/v1/challenges`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": operationKey,
    },
    body: JSON.stringify({
      recipient: { type: "phone", phoneNumber },
      purpose: "login",
      contextId,
      policyId: "default",
    }),
  });
  if (response.status !== 201) throw new Error(`Create failed with ${String(response.status)}`);
  return Schema.decodeUnknownSync(Snapshot)(await response.json());
};

const challengeStatus = async (
  port: number,
  challengeId: string,
  signal?: AbortSignal,
): Promise<Snapshot> => {
  const response = await fetch(
    `http://127.0.0.1:${String(port)}/v1/challenges/${encodeURIComponent(challengeId)}`,
    { headers: { authorization: `Bearer ${API_KEY}` }, signal: signal ?? null },
  );
  if (response.status !== 200) throw new Error(`Status failed with ${String(response.status)}`);
  return Schema.decodeUnknownSync(Snapshot)(await response.json());
};

const processEnvironment = (
  role: "api" | "worker" | "combined",
  port: number,
  internalPort: number,
  blocked = false,
): NodeJS.ProcessEnv => ({
  DATABASE_URL: requireFixture().postgres.databaseUrl,
  OTP_TEST_BLOCK: blocked ? "1" : "0",
  OTP_TEST_INTERNAL_PORT: String(internalPort),
  OTP_TEST_PORT: String(port),
  OTP_TEST_ROLE: role,
});

let postgres: PostgresFixture | undefined;
let temporaryDirectory: string | undefined;
let configurationPath: string | undefined;
let sinkPath: string | undefined;
let apiPort = 0;
let apiInternalPort = 0;
let workerPort = 0;
let workerInternalPort = 0;
let apiProcess: RunningProcess | undefined;
let workerProcess: RunningProcess | undefined;

const requireFixture = (): {
  readonly postgres: PostgresFixture;
  readonly configurationPath: string;
  readonly sinkPath: string;
} => {
  if (postgres === undefined || configurationPath === undefined || sinkPath === undefined) {
    throw new Error("Process fixture is not initialized");
  }
  return { postgres, configurationPath, sinkPath };
};

const psql = async (sql: string): Promise<string> => {
  const fixture = requireFixture();
  const result = await command("docker", [
    "exec",
    fixture.postgres.containerName,
    "psql",
    "-U",
    "postgres",
    "-d",
    "otp_router_test",
    "-At",
    "-c",
    sql,
  ]);
  return result.stdout.trim();
};

const superviseExpiredDeliveryJobs = async (): Promise<void> => {
  const boss = new PgBoss({
    connectionString: requireFixture().postgres.databaseUrl,
    monitorIntervalSeconds: 1,
    supervise: false,
  });
  await boss.start();
  try {
    await delay(1_100);
    await boss.supervise("otp-delivery-v1");
  } finally {
    await boss.stop({ close: true, graceful: true, timeout: 5_000 });
  }
};

beforeAll(async () => {
  postgres = await startPostgres();
  const cacheDirectory = join(ROOT, "node_modules", ".cache", "otp-router");
  await mkdir(cacheDirectory, { recursive: true });
  temporaryDirectory = await mkdtemp(join(cacheDirectory, "process-test-"));
  await chmod(temporaryDirectory, 0o700);
  sinkPath = join(temporaryDirectory, "provider-sink.jsonl");
  configurationPath = join(temporaryDirectory, "router.config.mjs");
  await writeFile(configurationPath, configSource(sinkPath), { encoding: "utf8", mode: 0o600 });
  [apiPort, apiInternalPort, workerPort, workerInternalPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
}, 120_000);

afterAll(async () => {
  await stopProcess(workerProcess);
  await stopProcess(apiProcess);
  await postgres?.close();
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

describe("built process", () => {
  it("supports config/schema checks and separate API and worker health", async () => {
    const fixture = requireFixture();
    const baseArgs = ["apps/server/dist/main.js", "--config", fixture.configurationPath];
    const checkConfig = startProcess(
      [...baseArgs, "--check-config"],
      processEnvironment("api", apiPort, apiInternalPort),
    );
    const configExit = await checkConfig.exit;
    expect(configExit.code).toBe(0);
    const logLines = checkConfig.output().trim().split("\n");
    expect(logLines).toHaveLength(1);
    expect(
      Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(
        JSON.parse(logLines[0] ?? ""),
      ).message,
    ).toBe("configuration_valid");
    const missing = startProcess(
      [
        "apps/server/dist/main.js",
        "--check-config",
        "--config",
        `${fixture.configurationPath}.missing`,
      ],
      processEnvironment("api", apiPort, apiInternalPort),
    );
    expect((await missing.exit).code).toBe(1);
    expect(missing.output()).toContain("configuration_module_failed");
    expect(missing.output()).not.toContain(fixture.configurationPath);

    const checkSchema = startProcess(
      [...baseArgs, "--check-schema"],
      processEnvironment("api", apiPort, apiInternalPort),
    );
    const schemaExit = await checkSchema.exit;
    expect(schemaExit.code).toBe(0);
    expect(checkSchema.output()).toContain("schemas_compatible");

    apiProcess = startProcess(baseArgs, processEnvironment("api", apiPort, apiInternalPort));
    await waitForReady(apiInternalPort, apiProcess);
    const live = await fetch(`http://127.0.0.1:${String(apiInternalPort)}/health/live`);
    expect(live.status).toBe(200);
  }, 120_000);

  it("runs HTTP create through a queued worker send and verifies with the sink code", async () => {
    const fixture = requireFixture();
    if (apiProcess === undefined) throw new Error("API process is not running");
    const created = await createChallenge(
      apiPort,
      "process-create-1",
      "process-flow-1",
      "+998901234567",
    );
    const deliveryId = await psql(
      `SELECT id FROM otp_router.deliveries WHERE challenge_id = '${created.challengeId}' AND reason = 'initial'`,
    );
    expect(created.state).toBe("queued");
    expect(await readSink(fixture.sinkPath)).toHaveLength(0);

    workerProcess = startProcess(
      ["apps/server/dist/main.js", "--config", fixture.configurationPath],
      processEnvironment("worker", workerPort, workerInternalPort),
    );
    await waitForReady(workerInternalPort, workerProcess);
    await waitFor("the deterministic provider send", async () =>
      (await readSink(fixture.sinkPath)).some((entry) => entry.deliveryId === deliveryId),
    );
    const entry = (await readSink(fixture.sinkPath)).find(
      (candidate) => candidate.deliveryId === deliveryId,
    );
    if (entry === undefined) throw new Error("Provider sink omitted the delivery");
    await waitFor(
      "accepted delivery state",
      async ({ signal }) =>
        (await challengeStatus(apiPort, created.challengeId, signal)).state === "accepted",
    );

    const verify = await fetch(
      `http://127.0.0.1:${String(apiPort)}/v1/challenges/${created.challengeId}/verify`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
          "idempotency-key": "process-verify-1",
        },
        body: JSON.stringify({ code: entry.code, purpose: "login", contextId: "process-flow-1" }),
      },
    );
    expect(verify.status).toBe(200);
    expect(Schema.decodeUnknownSync(VerificationResult)(await verify.json())).toMatchObject({
      challengeId: created.challengeId,
      contextId: "process-flow-1",
      purpose: "login",
    });
    await stopProcess(workerProcess);
    workerProcess = undefined;
  }, 120_000);

  it("recovers a killed in-flight worker as uncertain without a second provider send", async () => {
    const fixture = requireFixture();
    const before = (await readSink(fixture.sinkPath)).length;
    const created = await createChallenge(
      apiPort,
      "process-create-crash",
      "process-flow-crash",
      "+998901234568",
    );
    const deliveryId = await psql(
      `SELECT id FROM otp_router.deliveries WHERE challenge_id = '${created.challengeId}' AND reason = 'initial'`,
    );
    workerProcess = startProcess(
      ["apps/server/dist/main.js", "--config", fixture.configurationPath],
      processEnvironment("worker", workerPort, workerInternalPort, true),
    );
    await waitForReady(workerInternalPort, workerProcess);
    await waitFor("the blocked provider invocation", async () =>
      (await readSink(fixture.sinkPath)).some((entry) => entry.deliveryId === deliveryId),
    );
    workerProcess.child.kill("SIGKILL");
    const killed = await workerProcess.exit;
    expect(killed.signal).toBe("SIGKILL");
    workerProcess = undefined;

    expect(await psql(`SELECT state FROM otp_router.deliveries WHERE id = '${deliveryId}'`)).toBe(
      "dispatching",
    );
    expect(
      await psql(
        "UPDATE pgboss.job SET started_on = clock_timestamp() - interval '100 seconds' WHERE name = 'otp-delivery-v1' AND state = 'active' RETURNING state",
      ),
    ).toContain("active");
    await superviseExpiredDeliveryJobs();
    expect(
      await psql(
        "SELECT state || ':' || retry_count::text FROM pgboss.job WHERE name = 'otp-delivery-v1' AND state = 'retry'",
      ),
    ).toContain("retry:0");

    workerProcess = startProcess(
      ["apps/server/dist/main.js", "--config", fixture.configurationPath],
      processEnvironment("worker", workerPort, workerInternalPort),
    );
    await waitForReady(workerInternalPort, workerProcess);
    await waitFor(
      "uncertain recovery state",
      async ({ signal }) =>
        (await challengeStatus(apiPort, created.challengeId, signal)).state === "uncertain",
    );
    await delay(750);
    expect(await readSink(fixture.sinkPath)).toHaveLength(before + 1);
    expect(
      await psql(
        `SELECT state || ':' || acceptance || ':' || diagnostic_code FROM otp_router.deliveries WHERE id = '${deliveryId}'`,
      ),
    ).toBe("uncertain:unknown:worker_recovery");
    expect(
      await psql(
        "SELECT state || ':' || retry_count::text FROM pgboss.job WHERE name = 'otp-delivery-v1' AND state = 'completed' ORDER BY completed_on DESC LIMIT 1",
      ),
    ).toBe("completed:1");
  }, 120_000);

  it("rolls back a killed reservation and sends once after queue recovery", async () => {
    const fixture = requireFixture();
    await stopProcess(workerProcess);
    workerProcess = undefined;
    const created = await createChallenge(
      apiPort,
      "reservation-crash",
      "reservation-crash",
      "+998901234572",
    );
    const deliveryId = await psql(
      `SELECT id FROM otp_router.deliveries WHERE challenge_id = '${created.challengeId}' AND reason = 'initial'`,
    );
    const database = ManagedRuntime.make(
      PgClient.layer({ url: Redacted.make(fixture.postgres.databaseUrl), maxConnections: 1 }),
    );
    const locked = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const blocker = database.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // This test-owned table lock stops reservation INSERTs after eligibility has been checked.
            yield* sql`LOCK TABLE otp_router.quota_events IN SHARE MODE`;
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(release);
          }),
        );
      }),
    );
    try {
      await Effect.runPromise(Deferred.await(locked));
      workerProcess = startProcess(
        ["apps/server/dist/main.js", "--config", fixture.configurationPath],
        processEnvironment("worker", workerPort, workerInternalPort),
      );
      await waitForReady(workerInternalPort, workerProcess);
      await waitFor(
        "the reservation waiting to write quota usage",
        async () =>
          (await psql(
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO otp_router.quota_events%'",
          )) === "1",
      );
      workerProcess.child.kill("SIGKILL");
      expect((await workerProcess.exit).signal).toBe("SIGKILL");
      workerProcess = undefined;
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await blocker;
      await database.dispose();
    }
    expect(
      (await readSink(fixture.sinkPath)).filter((entry) => entry.deliveryId === deliveryId),
    ).toHaveLength(0);
    expect(await psql(`SELECT state FROM otp_router.deliveries WHERE id = '${deliveryId}'`)).toBe(
      "pending",
    );
    expect(
      await psql(
        `SELECT send_count FROM otp_router.challenges WHERE id = '${created.challengeId}'`,
      ),
    ).toBe("0");
    expect(
      await psql(`SELECT count(*) FROM otp_router.quota_events WHERE event_id = '${deliveryId}'`),
    ).toBe("0");
    await psql(
      "UPDATE pgboss.job SET started_on = clock_timestamp() - interval '100 seconds' WHERE name = 'otp-delivery-v1' AND state = 'active'",
    );
    await superviseExpiredDeliveryJobs();
    workerProcess = startProcess(
      ["apps/server/dist/main.js", "--config", fixture.configurationPath],
      processEnvironment("worker", workerPort, workerInternalPort),
    );
    await waitForReady(workerInternalPort, workerProcess);
    await waitFor(
      "the recovered pending delivery",
      async ({ signal }) =>
        (await challengeStatus(apiPort, created.challengeId, signal)).state === "accepted",
    );
    expect(
      (await readSink(fixture.sinkPath)).filter((entry) => entry.deliveryId === deliveryId),
    ).toHaveLength(1);
    expect(
      await psql(
        `SELECT send_count FROM otp_router.challenges WHERE id = '${created.challengeId}'`,
      ),
    ).toBe("1");
    expect(
      await psql(`SELECT count(*) FROM otp_router.quota_events WHERE event_id = '${deliveryId}'`),
    ).toBe("2");
  }, 30_000);

  it("keeps a committed dispatch uncertain when killed before external transmission", async () => {
    const fixture = requireFixture();
    await stopProcess(workerProcess);
    workerProcess = undefined;
    const created = await createChallenge(
      apiPort,
      "before-network-crash",
      "before-network-crash",
      "+998901234573",
    );
    const deliveryId = await psql(
      `SELECT id FROM otp_router.deliveries WHERE challenge_id = '${created.challengeId}' AND reason = 'initial'`,
    );
    workerProcess = startProcess(
      ["apps/server/dist/main.js", "--config", fixture.configurationPath],
      {
        ...processEnvironment("worker", workerPort, workerInternalPort),
        OTP_TEST_BEFORE_SEND: "1",
      },
    );
    await waitForReady(workerInternalPort, workerProcess);
    await waitFor(
      "the committed dispatch before external transmission",
      async ({ signal }) =>
        (await challengeStatus(apiPort, created.challengeId, signal)).state === "sending",
    );
    workerProcess.child.kill("SIGKILL");
    expect((await workerProcess.exit).signal).toBe("SIGKILL");
    workerProcess = undefined;
    expect(
      (await readSink(fixture.sinkPath)).filter((entry) => entry.deliveryId === deliveryId),
    ).toHaveLength(0);
    await psql(
      "UPDATE pgboss.job SET started_on = clock_timestamp() - interval '100 seconds' WHERE name = 'otp-delivery-v1' AND state = 'active'",
    );
    await superviseExpiredDeliveryJobs();
    workerProcess = startProcess(
      ["apps/server/dist/main.js", "--config", fixture.configurationPath],
      processEnvironment("worker", workerPort, workerInternalPort),
    );
    await waitForReady(workerInternalPort, workerProcess);
    await waitFor(
      "uncertain recovery before transmission",
      async ({ signal }) =>
        (await challengeStatus(apiPort, created.challengeId, signal)).state === "uncertain",
    );
    expect(
      (await readSink(fixture.sinkPath)).filter((entry) => entry.deliveryId === deliveryId),
    ).toHaveLength(0);
    expect(
      await psql(
        `SELECT send_count FROM otp_router.challenges WHERE id = '${created.challengeId}'`,
      ),
    ).toBe("1");
    expect(
      await psql(`SELECT count(*) FROM otp_router.quota_events WHERE event_id = '${deliveryId}'`),
    ).toBe("2");
  }, 30_000);

  it("does not resend acceptance lost before the outcome transaction commits", async () => {
    const fixture = requireFixture();
    await stopProcess(workerProcess);
    workerProcess = undefined;
    const created = await createChallenge(
      apiPort,
      "process-accepted-crash",
      "process-accepted-crash",
      "+998901234571",
    );
    const deliveryId = await psql(
      `SELECT id FROM otp_router.deliveries WHERE challenge_id = '${created.challengeId}' AND reason = 'initial'`,
    );
    const database = ManagedRuntime.make(
      PgClient.layer({
        url: Redacted.make(fixture.postgres.databaseUrl),
        maxConnections: 1,
      }),
    );
    const locked = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const blocker = database.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // The dispatch gate does not take this lock. Only the outcome/callback transaction does.
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('callback:process-fake',0))`;
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(release);
          }),
        );
      }),
    );
    try {
      await Effect.runPromise(Deferred.await(locked));
      workerProcess = startProcess(
        ["apps/server/dist/main.js", "--config", fixture.configurationPath],
        processEnvironment("worker", workerPort, workerInternalPort),
      );
      await waitForReady(workerInternalPort, workerProcess);
      await waitFor(
        "the accepted response waiting to persist",
        async () =>
          (await psql(
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock%'",
          )) === "1",
      );
      expect(
        (await readSink(fixture.sinkPath)).filter((entry) => entry.deliveryId === deliveryId),
      ).toHaveLength(1);
      workerProcess.child.kill("SIGKILL");
      expect((await workerProcess.exit).signal).toBe("SIGKILL");
      workerProcess = undefined;
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await blocker;
      await database.dispose();
    }
    expect(await psql(`SELECT state FROM otp_router.deliveries WHERE id = '${deliveryId}'`)).toBe(
      "dispatching",
    );
    expect(
      await psql(
        `SELECT count(*) FROM otp_router.provider_correlations WHERE delivery_id = '${deliveryId}' AND reference = 'process:${deliveryId}'`,
      ),
    ).toBe("0");
    await psql(
      "UPDATE pgboss.job SET started_on = clock_timestamp() - interval '100 seconds' WHERE name = 'otp-delivery-v1' AND state = 'active'",
    );
    await superviseExpiredDeliveryJobs();
    workerProcess = startProcess(
      ["apps/server/dist/main.js", "--config", fixture.configurationPath],
      processEnvironment("worker", workerPort, workerInternalPort),
    );
    await waitForReady(workerInternalPort, workerProcess);
    await waitFor(
      "uncertain recovery after lost acceptance",
      async ({ signal }) =>
        (await challengeStatus(apiPort, created.challengeId, signal)).state === "uncertain",
    );
    expect(
      (await readSink(fixture.sinkPath)).filter((entry) => entry.deliveryId === deliveryId),
    ).toHaveLength(1);
    expect(
      await psql(
        `SELECT send_count FROM otp_router.challenges WHERE id = '${created.challengeId}'`,
      ),
    ).toBe("1");
    expect(
      await psql(`SELECT count(*) FROM otp_router.quota_events WHERE event_id = '${deliveryId}'`),
    ).toBe("2");
  }, 30_000);

  it("recovers a discarded creation response and serializes replay across independent API processes", async () => {
    const fixture = requireFixture();
    const otherPort = await reservePort();
    const otherInternal = await reservePort();
    const other = startProcess(
      ["apps/server/dist/main.js", "--config", fixture.configurationPath],
      processEnvironment("api", otherPort, otherInternal),
    );
    try {
      await waitForReady(otherInternal, other);
      const body = JSON.stringify({
        recipient: { type: "phone", phoneNumber: "+998901234570" },
        purpose: "login",
        contextId: "multiprocess-flow",
        policyId: "default",
      });
      await new Promise<void>((resolveDiscard, reject) => {
        const socket = connect(apiPort, "127.0.0.1");
        socket.once("error", reject);
        socket.once("data", () => {
          // Simulate a client that loses the response before consuming its challenge ID.
          socket.destroy();
          resolveDiscard();
        });
        socket.write(
          [
            "POST /v1/challenges HTTP/1.1",
            "Host: localhost",
            `Authorization: Bearer ${API_KEY}`,
            "Content-Type: application/json",
            "Idempotency-Key: multiprocess-create",
            `Content-Length: ${String(Buffer.byteLength(body))}`,
            "Connection: close",
            "",
            body,
          ].join("\r\n"),
        );
      });
      expect(
        await psql(
          "SELECT count(*) FROM otp_router.challenges WHERE context_id = 'multiprocess-flow'",
        ),
      ).toBe("1");
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          createChallenge(
            index % 2 === 0 ? apiPort : otherPort,
            "multiprocess-create",
            "multiprocess-flow",
            "+998901234570",
          ),
        ),
      );
      const created = results[0];
      if (created === undefined) throw new Error("No create result");
      const deliveryId = await psql(
        `SELECT id FROM otp_router.deliveries WHERE challenge_id = '${created.challengeId}' AND reason = 'initial'`,
      );
      expect(new Set(results.map((result) => result.challengeId)).size).toBe(1);
      expect(
        await psql(
          `SELECT count(*) FROM otp_router.deliveries WHERE challenge_id = '${created.challengeId}'`,
        ),
      ).toBe("1");
      await waitFor("multiprocess send", async () =>
        (await readSink(fixture.sinkPath)).some((entry) => entry.deliveryId === deliveryId),
      );
      const sent = (await readSink(fixture.sinkPath)).find(
        (entry) => entry.deliveryId === deliveryId,
      );
      if (sent === undefined) throw new Error("No sink entry");
      const responses = await Promise.all(
        [apiPort, otherPort].map((port, index) =>
          fetch(`http://127.0.0.1:${String(port)}/v1/challenges/${created.challengeId}/verify`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${API_KEY}`,
              "content-type": "application/json",
              "idempotency-key": `multiprocess-verify-${String(index)}`,
            },
            body: JSON.stringify({
              code: sent.code,
              purpose: "login",
              contextId: "multiprocess-flow",
            }),
          }),
        ),
      );
      expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
        200, 409,
      ]);
      expect(
        await psql(
          `SELECT count(*) FROM otp_router.challenge_secrets WHERE challenge_id = '${created.challengeId}'`,
        ),
      ).toBe("0");
      expect(
        (await readSink(fixture.sinkPath)).filter((entry) => entry.deliveryId === deliveryId),
      ).toHaveLength(1);
    } finally {
      await stopProcess(other);
    }
  }, 30_000);

  it("keeps liveness responsive and fails readiness during a database outage", async () => {
    const fixture = requireFixture();
    if (apiProcess === undefined) throw new Error("API process is not running");
    await command("docker", ["pause", fixture.postgres.containerName]);
    try {
      const live = await fetch(`http://127.0.0.1:${String(apiInternalPort)}/health/live`, {
        signal: AbortSignal.timeout(2_000),
      });
      expect(live.status).toBe(200);
      const ready = await fetch(`http://127.0.0.1:${String(apiInternalPort)}/health/ready`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: "unavailable" });
    } finally {
      await command("docker", ["unpause", fixture.postgres.containerName]);
    }
    await waitForReady(apiInternalPort, apiProcess);
  }, 20_000);

  it("bounds shutdown with an unfinished HTTP body and an in-flight provider call", async () => {
    const fixture = requireFixture();
    await stopProcess(workerProcess);
    workerProcess = undefined;
    await stopProcess(apiProcess);
    apiProcess = startProcess(
      ["apps/server/dist/main.js", "--config", fixture.configurationPath],
      processEnvironment("combined", apiPort, apiInternalPort, true),
    );
    await waitForReady(apiInternalPort, apiProcess);
    const runId = randomUUID();
    const created = await createChallenge(
      apiPort,
      `shutdown-create-${runId}`,
      `shutdown-flow-${runId}`,
      "+998901234569",
    );
    const deliveryId = await psql(
      `SELECT id FROM otp_router.deliveries WHERE challenge_id = '${created.challengeId}' AND reason = 'initial'`,
    );
    await waitFor("blocked shutdown send", async () =>
      (await readSink(fixture.sinkPath)).some((entry) => entry.deliveryId === deliveryId),
    );
    const socket = connect(apiPort, "127.0.0.1");
    const continued = new Promise<void>((resolveContinue, reject) => {
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        if (chunk.toString().includes("100 Continue")) resolveContinue();
      });
    });
    try {
      socket.write(
        [
          "POST /v1/challenges HTTP/1.1",
          "Host: localhost",
          `Authorization: Bearer ${API_KEY}`,
          "Content-Type: application/json",
          "Idempotency-Key: shutdown-incomplete",
          "Content-Length: 1000",
          "Expect: 100-continue",
          "",
          "",
        ].join("\r\n"),
      );
      await continued;
      const started = performance.now();
      apiProcess.child.kill("SIGTERM");
      const result = await Promise.race([
        apiProcess.exit,
        delay(4_000).then(() => {
          throw new Error("Shutdown exceeded its deadline");
        }),
      ]);
      expect(result.code).toBe(0);
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(
        (await readSink(fixture.sinkPath)).filter((entry) => entry.deliveryId === deliveryId),
      ).toHaveLength(1);
      expect(await psql(`SELECT state FROM otp_router.deliveries WHERE id = '${deliveryId}'`)).toBe(
        "dispatching",
      );
      expect(apiProcess.output()).not.toContain(API_KEY);
      expect(apiProcess.output()).not.toContain("+998901234569");
    } finally {
      socket.destroy();
      await stopProcess(apiProcess);
    }
  }, 30_000);
});
