import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Schema } from "effect";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type PostgresFixture } from "./fixture.js";

const API_KEY = "benchmark-api-key-with-at-least-thirty-two-bytes";
const ROOT = resolve(import.meta.dirname, "..");
const STEADY_DURATION_MS = Number(process.env["OTP_BENCHMARK_STEADY_MS"] ?? 15 * 60 * 1000);
const STEADY_TARGET_OPS_PER_SECOND = 5;
const RAMP_CONCURRENCY = [1, 4, 8, 16, 32] as const;
const RAMP_REQUESTS_PER_LEVEL = 200;
const WORKER_CONCURRENCY = 8;
const BACKLOG_SIZE = 50;
const CLEANUP_BACKLOG_SIZE = 250;
const MAX_STEADY_CLEANUP_LAG_SECONDS = 90;
const RECOVERY_ONLY = process.env["OTP_BENCHMARK_RECOVERY_ONLY"] === "1";

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
      server.close((error) => {
        if (error === undefined) resolvePort(address.port);
        else reject(error);
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
  predicate: () => Promise<boolean>,
  timeoutMilliseconds = 120_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
};

const waitForReady = async (port: number, running: RunningProcess): Promise<void> =>
  waitFor("process readiness", async () => {
    if (running.child.exitCode !== null) {
      throw new Error(`Router exited before readiness: ${running.output()}`);
    }
    try {
      return (await fetch(`http://127.0.0.1:${String(port)}/health/ready`)).status === 200;
    } catch {
      return false;
    }
  });

const key = (byte: number): string => Buffer.alloc(32, byte).toString("base64url");

const configSource = (sinkPath: string): string => {
  return `import { appendFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { defineConfig } from "@otp-router/server/config";
import { ProviderContractVersion, ProviderInstance } from "@otp-router/engine/providers";

const sink = ${JSON.stringify(sinkPath)};
const provider = {
  instanceId: "benchmark-fake",
  pluginId: "benchmark-fake",
  version: "1.0.0",
  contractVersion: ProviderContractVersion,
  channel: "fake",
  enabled: true,
  settingsFingerprint: "benchmark-fake-v1",
  constraints: { minCodeLength: 6, maxCodeLength: 8, minDeliveryWindowMs: 0 },
  defaultSendTimeoutMs: 1000,
  sendTimeoutMs: 1000,
  diagnosticCodes: [],
  idempotency: { supported: false },
  resolveTemplate: (locales) => Effect.succeed({ locale: locales[0] ?? "en", template: null }),
  send: (input) => Effect.promise(async () => {
    await appendFile(sink, JSON.stringify({ attemptId: input.attemptId, invokedAt: Date.now() }) + "\\n", { encoding: "utf8", mode: 0o600 });
    if (process.env.OTP_BENCHMARK_BLOCK === "1") await new Promise(() => {});
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    return { providerRequestId: "benchmark:" + input.attemptId };
  }),
};

export default defineConfig({
  engine: {
  settings: {
    crypto: {
      deploymentId: "benchmark-local",
      encryption: { active: "enc-v1", keys: { "enc-v1": ${JSON.stringify(key(11))} } },
      verification: { active: "verify-v1", keys: { "verify-v1": ${JSON.stringify(key(12))} } },
      fingerprint: { active: "fingerprint-v1", keys: { "fingerprint-v1": ${JSON.stringify(key(13))} } },
      recipientKey: ${JSON.stringify(key(14))},
    },
    defaultLocale: "en",
    fallbackLocales: [],
    policies: { benchmark: { providerInstanceIds: ["benchmark-fake"], managed: { lifetimeSeconds: 600 }, maxSends: 10, resendCooldownSeconds: 30 } },
    purposes: { benchmark: ["benchmark"] },
    deploymentSendLimit15m: 1000000,
    deploymentSendLimit24h: 1000000,
    recipientCreateLimit15m: 5,
    recipientSendLimit15m: 10,
    recipientGuessLimit15m: 10,
    providerSendLimits15m: { "benchmark-fake": 1000000 },
  },
  providers: [Layer.succeed(ProviderInstance, provider)],
  },
  settings: {
    databaseUrl: process.env.DATABASE_URL,
    apiKeys: [${JSON.stringify(API_KEY)}],
    role: process.env.OTP_BENCHMARK_ROLE,
    port: Number(process.env.OTP_BENCHMARK_PORT),
    internalPort: Number(process.env.OTP_BENCHMARK_INTERNAL_PORT),
    host: "127.0.0.1",
    internalHost: "127.0.0.1",
    workerConcurrency: ${String(WORKER_CONCURRENCY)},
    shutdownGraceMs: 30000,
  },
});
`;
};

const SinkEntry = Schema.Struct({
  attemptId: Schema.String,
  invokedAt: Schema.Number,
});
type SinkEntry = typeof SinkEntry.Type;

const readSink = async (path: string): Promise<ReadonlyArray<SinkEntry>> => {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => Schema.decodeUnknownSync(SinkEntry)(JSON.parse(line)));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
};

const MinimalSnapshot = Schema.Struct({
  challengeId: Schema.String.check(Schema.isUUID()),
  state: Schema.String,
});
type MinimalSnapshot = typeof MinimalSnapshot.Type;

const attemptIdFrom = async (observation: HttpObservation): Promise<string> => {
  const id = observation.snapshot?.challengeId;
  if (id === undefined) throw new Error("Challenge response omitted its challenge ID");
  return psql(
    `SELECT id FROM otp_router.delivery_attempts WHERE operation_id IN (SELECT operation_id FROM otp_router.challenges WHERE id::text = '${id}') AND reason = 'initial'`,
  );
};

interface HttpObservation {
  readonly latencyMs: number;
  readonly snapshot?: MinimalSnapshot;
  readonly status: number;
}

interface Summary {
  readonly count: number;
  readonly errors: Readonly<Record<string, number>>;
  readonly operationsPerSecond: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

const percentile = (values: ReadonlyArray<number>, fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
};

const rounded = (value: number): number => Math.round(value * 100) / 100;

const summarize = (
  observations: ReadonlyArray<HttpObservation>,
  durationMilliseconds: number,
): Summary => {
  const errors: Record<string, number> = {};
  for (const observation of observations) {
    if (observation.status === 201) continue;
    const key = String(observation.status);
    errors[key] = (errors[key] ?? 0) + 1;
  }
  const latencies = observations.map((observation) => observation.latencyMs);
  return {
    count: observations.length,
    errors,
    operationsPerSecond: rounded(observations.length / (durationMilliseconds / 1000)),
    p50Ms: rounded(percentile(latencies, 0.5)),
    p95Ms: rounded(percentile(latencies, 0.95)),
    p99Ms: rounded(percentile(latencies, 0.99)),
  };
};

interface ResourceSample {
  readonly apiCpuPercent: number;
  readonly apiRssBytes: number;
  readonly cleanupMaxOverdueSeconds: number;
  readonly cleanupOverdueCount: number;
  readonly databaseConnections: number;
  readonly freeSystemMemoryBytes: number;
  readonly postgresMemoryBytes: number;
  readonly workerCpuPercent: number;
  readonly workerRssBytes: number;
}

interface ProcessMetrics {
  readonly cpuPercent: number;
  readonly rssBytes: number;
}

const processMetrics = async (pid: number): Promise<ProcessMetrics> => {
  const result = await command("ps", ["-o", "rss=,%cpu=", "-p", String(pid)]);
  const fields = result.stdout.trim().split(/\s+/u);
  const rssKilobytes = Number(fields[0]);
  const cpuPercent = Number(fields[1]);
  if (!Number.isFinite(rssKilobytes) || !Number.isFinite(cpuPercent)) {
    throw new Error("Could not parse process resource metrics");
  }
  return { cpuPercent, rssBytes: rssKilobytes * 1024 };
};

const memoryBytes = (value: string): number => {
  const match = /^([0-9]+(?:\.[0-9]+)?)(B|KiB|MiB|GiB)$/u.exec(value.trim());
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error("Could not parse Docker memory metrics");
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case "B":
      return amount;
    case "KiB":
      return amount * 1024;
    case "MiB":
      return amount * 1024 * 1024;
    case "GiB":
      return amount * 1024 * 1024 * 1024;
    default:
      throw new Error("Docker returned an unsupported memory unit");
  }
};

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
let recipientSequence = 0;

const requireFixture = (): {
  readonly configurationPath: string;
  readonly postgres: PostgresFixture;
  readonly sinkPath: string;
} => {
  if (postgres === undefined || configurationPath === undefined || sinkPath === undefined) {
    throw new Error("Benchmark fixture is not initialized");
  }
  return { configurationPath, postgres, sinkPath };
};

const psql = async (sql: string): Promise<string> => {
  const result = await command("docker", [
    "exec",
    requireFixture().postgres.containerName,
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

interface DatabaseOperationalMetrics {
  readonly cleanupMaxOverdueSeconds: number;
  readonly cleanupOverdueCount: number;
  readonly connections: number;
}

const databaseOperationalMetrics = async (): Promise<DatabaseOperationalMetrics> => {
  const result = await psql(
    "SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()), (SELECT count(*) FROM (SELECT c.*,o.send_count,o.recipient_token,o.snapshot,o.expires_at FROM otp_router.challenges c JOIN otp_router.delivery_operations o ON o.id = c.operation_id) AS challenges WHERE verification_state='active' AND expires_at<clock_timestamp()), (SELECT COALESCE(max(extract(epoch FROM (clock_timestamp()-expires_at))),0) FROM (SELECT c.*,o.send_count,o.recipient_token,o.snapshot,o.expires_at FROM otp_router.challenges c JOIN otp_router.delivery_operations o ON o.id = c.operation_id) AS challenges WHERE verification_state='active' AND expires_at<clock_timestamp())",
  );
  const [connections, cleanupOverdueCount, cleanupMaxOverdueSeconds] = result
    .split("|")
    .map(Number);
  if (
    connections === undefined ||
    cleanupOverdueCount === undefined ||
    cleanupMaxOverdueSeconds === undefined ||
    !Number.isFinite(connections) ||
    !Number.isFinite(cleanupOverdueCount) ||
    !Number.isFinite(cleanupMaxOverdueSeconds)
  ) {
    throw new Error("Could not parse database operational metrics");
  }
  return { cleanupMaxOverdueSeconds, cleanupOverdueCount, connections };
};

const postgresMemoryBytes = async (): Promise<number> => {
  const result = await command("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.MemUsage}}",
    requireFixture().postgres.containerName,
  ]);
  return memoryBytes(result.stdout.split("/")[0] ?? "");
};

const EMPTY_RESOURCE_SAMPLE: ResourceSample = {
  apiCpuPercent: 0,
  apiRssBytes: 0,
  cleanupMaxOverdueSeconds: 0,
  cleanupOverdueCount: 0,
  databaseConnections: 0,
  freeSystemMemoryBytes: 0,
  postgresMemoryBytes: 0,
  workerCpuPercent: 0,
  workerRssBytes: 0,
};

const collectResourceSample = async (
  resourceSamples: ResourceSample[],
  sampleIndex: number,
): Promise<void> => {
  const apiPid = apiProcess?.child.pid;
  const workerPid = workerProcess?.child.pid;
  if (apiPid === undefined || workerPid === undefined) return;
  const [api, worker] = await Promise.all([processMetrics(apiPid), processMetrics(workerPid)]);
  const previous = resourceSamples.at(-1) ?? EMPTY_RESOURCE_SAMPLE;
  let database: DatabaseOperationalMetrics = {
    cleanupMaxOverdueSeconds: previous.cleanupMaxOverdueSeconds,
    cleanupOverdueCount: previous.cleanupOverdueCount,
    connections: previous.databaseConnections,
  };
  if (sampleIndex % 2 === 0) database = await databaseOperationalMetrics();
  let postgresMemory = previous.postgresMemoryBytes;
  if (sampleIndex % 12 === 0) postgresMemory = await postgresMemoryBytes();
  resourceSamples.push({
    apiCpuPercent: api.cpuPercent,
    apiRssBytes: api.rssBytes,
    cleanupMaxOverdueSeconds: database.cleanupMaxOverdueSeconds,
    cleanupOverdueCount: database.cleanupOverdueCount,
    databaseConnections: database.connections,
    freeSystemMemoryBytes: freemem(),
    postgresMemoryBytes: postgresMemory,
    workerCpuPercent: worker.cpuPercent,
    workerRssBytes: worker.rssBytes,
  });
};

const sampleResources = async (
  resourceSamples: ResourceSample[],
  isSampling: () => boolean,
): Promise<void> => {
  let sampleIndex = 0;
  while (isSampling()) {
    await collectResourceSample(resourceSamples, sampleIndex);
    sampleIndex += 1;
    await delay(2_500);
  }
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

const processEnvironment = (
  role: "api" | "worker",
  port: number,
  internalPort: number,
  blocked = false,
): NodeJS.ProcessEnv => ({
  DATABASE_URL: requireFixture().postgres.databaseUrl,
  OTP_BENCHMARK_BLOCK: blocked ? "1" : "0",
  OTP_BENCHMARK_INTERNAL_PORT: String(internalPort),
  OTP_BENCHMARK_PORT: String(port),
  OTP_BENCHMARK_ROLE: role,
});

const createChallenge = async (
  phase: string,
  includeSnapshot = false,
): Promise<HttpObservation> => {
  const sequence = recipientSequence;
  recipientSequence += 1;
  const phone = `+99890${String(sequence).padStart(7, "0")}`;
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${String(apiPort)}/v1/challenges`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": `${phase}-${String(sequence)}-${randomUUID()}`,
    },
    body: JSON.stringify({
      recipient: { type: "phone", phoneNumber: phone },
      purpose: "benchmark",
      contextId: `${phase}-${String(sequence)}`,
      policyId: "benchmark",
    }),
  });
  const latencyMs = performance.now() - started;
  if (!includeSnapshot || response.status !== 201) {
    await response.arrayBuffer();
    return { latencyMs, status: response.status };
  }
  const body: unknown = await response.json();
  return {
    latencyMs,
    snapshot: Schema.decodeUnknownSync(MinimalSnapshot)(body),
    status: response.status,
  };
};

const runSteady = async (): Promise<{
  readonly durationMs: number;
  readonly values: HttpObservation[];
}> => {
  const values: HttpObservation[] = [];
  const intervalMilliseconds = 1000 / STEADY_TARGET_OPS_PER_SECOND;
  const started = performance.now();
  let nextRequest = started;
  let nextProgress = started + 60_000;
  while (performance.now() - started < STEADY_DURATION_MS) {
    const remaining = nextRequest - performance.now();
    if (remaining > 0) await delay(remaining);
    values.push(await createChallenge("steady"));
    nextRequest += intervalMilliseconds;
    if (performance.now() >= nextProgress) {
      process.stdout.write(
        `${JSON.stringify({ benchmarkProgress: { elapsedSeconds: Math.round((performance.now() - started) / 1000), requests: values.length } })}\n`,
      );
      nextProgress += 60_000;
    }
  }
  return { durationMs: performance.now() - started, values };
};

const runCreateBatch = async (
  phase: string,
  requestCount: number,
  concurrency: number,
  includeSnapshots = false,
): Promise<{ readonly durationMs: number; readonly values: HttpObservation[] }> => {
  const values: HttpObservation[] = [];
  let next = 0;
  const started = performance.now();
  const runner = async (): Promise<void> => {
    while (next < requestCount) {
      next += 1;
      values.push(await createChallenge(phase, includeSnapshots));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, runner));
  return { durationMs: performance.now() - started, values };
};

const runRamp = async (): Promise<ReadonlyArray<Summary & { readonly concurrency: number }>> => {
  const ramp = [];
  for (const concurrency of RAMP_CONCURRENCY) {
    const level = await runCreateBatch(
      `ramp-${String(concurrency)}`,
      RAMP_REQUESTS_PER_LEVEL,
      concurrency,
    );
    ramp.push({ concurrency, ...summarize(level.values, level.durationMs) });
  }
  return ramp;
};

const expectNoRampErrors = (
  ramp: ReadonlyArray<Summary & { readonly concurrency: number }>,
): void => {
  for (const level of ramp) expect(level.errors).toEqual({});
};

const queuedCount = async (): Promise<number> =>
  Number(
    await psql(
      "SELECT count(*) FROM otp_router.delivery_attempts WHERE state IN ('pending','dispatching')",
    ),
  );

const waitForDrain = async (): Promise<void> =>
  waitFor("delivery queue to drain", async () => (await queuedCount()) === 0, 180_000);

const queueDelayPercentiles = async (): Promise<ReadonlyArray<number>> => {
  const result = await psql(
    "SELECT percentile_cont(ARRAY[0.5,0.95,0.99]) WITHIN GROUP (ORDER BY extract(epoch FROM (reserved_at-due_at))*1000) FROM otp_router.delivery_attempts WHERE reserved_at IS NOT NULL",
  );
  return result.replace(/[{}]/gu, "").split(",").map(Number);
};

interface CleanupRecoveryReport {
  readonly cleanupBacklogSize: number;
  readonly cleanupRecoveryMs: number;
  readonly cohortIdsMatched: number;
  readonly remainingSecrets: number;
  readonly remainingUnexpired: number;
}

const cleanupRecoveryOnly = async (args: ReadonlyArray<string>): Promise<CleanupRecoveryReport> => {
  const observations = (await runCreateBatch("cleanup-cohort", CLEANUP_BACKLOG_SIZE, 4, true))
    .values;
  expect(observations.every((observation) => observation.status === 201)).toBe(true);
  const cohortIds = observations.flatMap((observation) =>
    observation.snapshot === undefined ? [] : [observation.snapshot.challengeId],
  );
  expect(new Set(cohortIds).size).toBe(CLEANUP_BACKLOG_SIZE);
  await waitForDrain();
  const databaseCohortIds = (
    await psql(
      "SELECT id FROM otp_router.challenges WHERE context_id LIKE 'cleanup-cohort-%' ORDER BY id",
    )
  )
    .split("\n")
    .filter((id) => id.length > 0);
  expect(databaseCohortIds).toEqual([...cohortIds].sort());

  await stopProcess(workerProcess);
  workerProcess = undefined;
  const forcedExpired = Number(
    await psql(
      "WITH forced AS (UPDATE otp_router.delivery_operations SET expires_at=clock_timestamp()-interval '2 minutes' WHERE context_id LIKE 'cleanup-cohort-%' RETURNING 1) SELECT count(*) FROM forced",
    ),
  );
  expect(forcedExpired).toBe(CLEANUP_BACKLOG_SIZE);
  const cleanupRestarted = performance.now();
  workerProcess = startProcess(args, processEnvironment("worker", workerPort, workerInternalPort));
  await waitForReady(workerInternalPort, workerProcess);
  await waitFor(
    "captured challenge expiry cohort to become terminal",
    async () =>
      Number(
        await psql(
          "SELECT count(*) FROM otp_router.challenges WHERE context_id LIKE 'cleanup-cohort-%' AND verification_state<>'expired'",
        ),
      ) === 0,
    90_000,
  );
  const cleanupRecoveryMs = performance.now() - cleanupRestarted;
  const remainingUnexpired = Number(
    await psql(
      "SELECT count(*) FROM otp_router.challenges WHERE context_id LIKE 'cleanup-cohort-%' AND verification_state<>'expired'",
    ),
  );
  const remainingSecrets = Number(
    await psql(
      "SELECT count(*) FROM otp_router.challenge_secrets s JOIN otp_router.challenges c ON c.id=s.challenge_id WHERE c.context_id LIKE 'cleanup-cohort-%'",
    ),
  );
  expect(databaseCohortIds).toHaveLength(CLEANUP_BACKLOG_SIZE);
  expect(remainingSecrets).toBe(0);
  expect(remainingUnexpired).toBe(0);
  return {
    cleanupBacklogSize: CLEANUP_BACKLOG_SIZE,
    cleanupRecoveryMs: rounded(cleanupRecoveryMs),
    cohortIdsMatched: databaseCohortIds.length,
    remainingSecrets,
    remainingUnexpired,
  };
};

beforeAll(async () => {
  if (!Number.isFinite(STEADY_DURATION_MS) || STEADY_DURATION_MS <= 0) {
    throw new Error("OTP_BENCHMARK_STEADY_MS must be a positive number");
  }
  postgres = await startPostgres();
  const cacheDirectory = join(ROOT, "node_modules", ".cache", "otp-router");
  await mkdir(cacheDirectory, { recursive: true });
  temporaryDirectory = await mkdtemp(join(cacheDirectory, "capacity-benchmark-"));
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

describe("local capacity benchmark", () => {
  it("measures steady HTTP load, a concurrency ramp, and worker crash recovery", async () => {
    const fixture = requireFixture();
    const args = ["apps/server/dist/main.js", "--config", fixture.configurationPath];
    apiProcess = startProcess(args, processEnvironment("api", apiPort, apiInternalPort));
    await waitForReady(apiInternalPort, apiProcess);
    workerProcess = startProcess(
      args,
      processEnvironment("worker", workerPort, workerInternalPort),
    );
    await waitForReady(workerInternalPort, workerProcess);

    if (RECOVERY_ONLY) {
      const recoveryReport = await cleanupRecoveryOnly(args);
      process.stdout.write(`${JSON.stringify({ cleanupRecoveryReport: recoveryReport })}\n`);
      return;
    }

    const resourceSamples: ResourceSample[] = [];
    let sampling = true;
    const sampler = sampleResources(resourceSamples, () => sampling);

    const steady = await runSteady();
    await waitForDrain();
    const steadySummary = summarize(steady.values, steady.durationMs);
    const queueDelay = await queueDelayPercentiles();
    const steadyResourceSamples = [...resourceSamples];
    const steadyCleanupMaxOverdueSeconds = Math.max(
      ...steadyResourceSamples.map((sample) => sample.cleanupMaxOverdueSeconds),
    );
    process.stdout.write(
      `${JSON.stringify({ benchmarkPhaseReport: { phase: "steady", cleanupMaxOverdueSeconds: rounded(steadyCleanupMaxOverdueSeconds), ...steadySummary } })}\n`,
    );

    const ramp = await runRamp();
    await waitForDrain();
    process.stdout.write(`${JSON.stringify({ benchmarkPhaseReport: { phase: "ramp", ramp } })}\n`);

    await stopProcess(workerProcess);
    workerProcess = undefined;
    const baselineBacklog = await queuedCount();
    const forcedExpired = Number(
      await psql(
        "WITH forced AS (UPDATE otp_router.delivery_operations SET expires_at=clock_timestamp()-interval '2 minutes' WHERE id IN (SELECT id FROM otp_router.challenges WHERE verification_state='active' ORDER BY created_at DESC LIMIT 250) RETURNING 1) SELECT count(*) FROM forced",
      ),
    );
    expect(forcedExpired).toBe(CLEANUP_BACKLOG_SIZE);
    const backlogStart = performance.now();
    const backlogObservations = (await runCreateBatch("recovery-backlog", BACKLOG_SIZE, 4)).values;
    expect(backlogObservations.every((observation) => observation.status === 201)).toBe(true);
    expect(await queuedCount()).toBe(baselineBacklog + BACKLOG_SIZE);
    const cleanupRestarted = performance.now();
    workerProcess = startProcess(
      args,
      processEnvironment("worker", workerPort, workerInternalPort),
    );
    await waitForReady(workerInternalPort, workerProcess);
    await waitForDrain();
    const backlogRecoveryMs = performance.now() - backlogStart;
    expect(await queuedCount()).toBe(baselineBacklog);
    await waitFor(
      "forced challenge expiry backlog to drain",
      async () =>
        Number(
          await psql(
            "SELECT count(*) FROM (SELECT c.*,o.send_count,o.recipient_token,o.snapshot,o.expires_at FROM otp_router.challenges c JOIN otp_router.delivery_operations o ON o.id = c.operation_id) AS challenges WHERE verification_state='active' AND expires_at<clock_timestamp()-interval '90 seconds'",
          ),
        ) === 0,
      90_000,
    );
    const cleanupRecoveryMs = performance.now() - cleanupRestarted;
    expect(
      Number(
        await psql(
          "SELECT count(*) FROM otp_router.challenge_secrets s JOIN otp_router.challenges c ON c.id=s.challenge_id WHERE c.verification_state='expired'",
        ),
      ),
    ).toBe(0);

    await stopProcess(workerProcess);
    workerProcess = undefined;
    const crash = await createChallenge("recovery-crash", true);
    const crashDeliveryId = await attemptIdFrom(crash);
    workerProcess = startProcess(
      args,
      processEnvironment("worker", workerPort, workerInternalPort, true),
    );
    await waitForReady(workerInternalPort, workerProcess);
    await waitFor("blocked fake-provider invocation", async () =>
      (await readSink(fixture.sinkPath)).some((entry) => entry.attemptId === crashDeliveryId),
    );
    workerProcess.child.kill("SIGKILL");
    await workerProcess.exit;
    workerProcess = undefined;
    expect(
      await psql(
        "UPDATE pgboss.job SET started_on=clock_timestamp()-interval '100 seconds' WHERE name='otp-delivery-v1' AND state='active' RETURNING state",
      ),
    ).toContain("active");
    await superviseExpiredDeliveryJobs();
    expect(
      await psql(
        "SELECT state || ':' || retry_count::text FROM pgboss.job WHERE name='otp-delivery-v1' AND state='retry'",
      ),
    ).toContain("retry:0");
    const crashRestarted = performance.now();
    workerProcess = startProcess(
      args,
      processEnvironment("worker", workerPort, workerInternalPort),
    );
    await waitForReady(workerInternalPort, workerProcess);
    await waitFor(
      "crashed dispatch to become uncertain",
      async () =>
        (await psql(
          `SELECT state FROM otp_router.delivery_attempts WHERE id='${crashDeliveryId}'`,
        )) === "uncertain",
    );
    const crashRecoveryMs = performance.now() - crashRestarted;
    expect(
      await psql(
        "SELECT state || ':' || retry_count::text FROM pgboss.job WHERE name='otp-delivery-v1' AND state='completed' ORDER BY completed_on DESC LIMIT 1",
      ),
    ).toBe("completed:1");
    await delay(750);

    sampling = false;
    await sampler;
    const sink = await readSink(fixture.sinkPath);
    const invocationCounts = new Map<string, number>();
    for (const entry of sink) {
      invocationCounts.set(entry.attemptId, (invocationCounts.get(entry.attemptId) ?? 0) + 1);
    }
    const duplicateExternalSends = [...invocationCounts.values()].filter(
      (count) => count > 1,
    ).length;
    const deliveryCount = Number(await psql("SELECT count(*) FROM otp_router.delivery_attempts"));
    const terminalDeliveryCount = Number(
      await psql(
        "SELECT count(*) FROM otp_router.delivery_attempts WHERE state IN ('accepted','uncertain')",
      ),
    );
    const quotaExceeded = Number(
      await psql(
        "SELECT count(*) FROM (SELECT c.*,o.send_count,o.recipient_token,o.snapshot,o.expires_at FROM otp_router.challenges c JOIN otp_router.delivery_operations o ON o.id = c.operation_id) AS challenges WHERE send_count > 1",
      ),
    );
    const postgresVersion = await psql("SHOW server_version");
    const postgresMaxConnections = Number(await psql("SHOW max_connections"));
    const cpu = cpus();
    const report = {
      environment: {
        cpu: { logicalCount: cpu.length, model: cpu[0]?.model ?? "unknown" },
        memoryBytes: totalmem(),
        nodeVersion: process.version,
        operatingSystem: `${platform()} ${release()}`,
        postgres: {
          maxConnections: postgresMaxConnections,
          placement: "local Docker TCP",
          version: postgresVersion,
        },
        queue: { deliveryPollingSeconds: 0.5, pgBossPoolMax: 6 },
        serviceDatabasePoolMaxPerProcess: 10,
        workerConcurrency: WORKER_CONCURRENCY,
      },
      limits: {
        deploymentSendLimit15m: 1_000_000,
        deploymentSendLimit24h: 1_000_000,
        providerSendLimit15m: 1_000_000,
        recipientCreateLimit15m: 5,
        syntheticRecipients: true,
      },
      ramp,
      recovery: {
        backlogRecoveryMs: rounded(backlogRecoveryMs),
        backlogSize: BACKLOG_SIZE,
        cleanupBacklogSize: CLEANUP_BACKLOG_SIZE,
        cleanupRecoveryMs: rounded(cleanupRecoveryMs),
        crashRecoveryMs: rounded(crashRecoveryMs),
        duplicateExternalSends,
      },
      resources: {
        peakApiCpuPercent: Math.max(...resourceSamples.map((sample) => sample.apiCpuPercent)),
        peakApiRssBytes: Math.max(...resourceSamples.map((sample) => sample.apiRssBytes)),
        peakDatabaseConnections: Math.max(
          ...resourceSamples.map((sample) => sample.databaseConnections),
        ),
        peakPostgresMemoryBytes: Math.max(
          ...resourceSamples.map((sample) => sample.postgresMemoryBytes),
        ),
        peakWorkerCpuPercent: Math.max(...resourceSamples.map((sample) => sample.workerCpuPercent)),
        peakWorkerRssBytes: Math.max(...resourceSamples.map((sample) => sample.workerRssBytes)),
      },
      steady: {
        configuredDurationMs: STEADY_DURATION_MS,
        queueDelayP50Ms: rounded(queueDelay[0] ?? 0),
        queueDelayP95Ms: rounded(queueDelay[1] ?? 0),
        queueDelayP99Ms: rounded(queueDelay[2] ?? 0),
        cleanupMaxOverdueSeconds: rounded(steadyCleanupMaxOverdueSeconds),
        targetOperationsPerSecond: STEADY_TARGET_OPS_PER_SECOND,
        ...steadySummary,
      },
      totals: { deliveryCount, externalInvocations: sink.length, terminalDeliveryCount },
    };
    process.stdout.write(`${JSON.stringify({ benchmarkReport: report })}\n`);

    expect(steadySummary.errors).toEqual({});
    expectNoRampErrors(ramp);
    expect(crash.status).toBe(201);
    expect(duplicateExternalSends).toBe(0);
    expect(quotaExceeded).toBe(0);
    expect(terminalDeliveryCount).toBe(deliveryCount);
    expect(sink.length).toBe(deliveryCount);
    expect(resourceSamples.length).toBeGreaterThan(0);
    expect(steadyCleanupMaxOverdueSeconds).toBeLessThanOrEqual(MAX_STEADY_CLEANUP_LAG_SECONDS);
    expect(report.resources.peakDatabaseConnections).toBeLessThanOrEqual(postgresMaxConnections);
  });
});
