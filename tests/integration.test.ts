import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import {
  Snapshot,
  VerificationResult,
  type CreateInput,
  type OperationResult,
} from "../src/challenges/contracts.js";
import { createChallenge } from "../src/challenges/create.js";
import { decrypt, operationIdentity } from "../src/challenges/crypto.js";
import { verifyChallenge } from "../src/challenges/verify.js";
import { RouterConfig, type RuntimeConfiguration } from "../src/config/config.js";
import { rows, single } from "../src/database/query.js";
import { ingestEvents } from "../src/delivery/callbacks.js";
import { requestDelivery } from "../src/delivery/actions.js";
import { dispatch, dispatchGate } from "../src/delivery/dispatch.js";
import { recordOutcome } from "../src/delivery/outcomes.js";
import { makeWebHandler } from "../src/http/transport.js";
import { WebhookError, WebhookHandler } from "../src/http/webhooks.js";
import { WebhooksLive } from "../src/http/webhook-service.js";
import {
  ProviderContractVersion,
  ProviderConfigurationRejected,
  ProviderInstance,
  ProviderInstanceIdSchema,
  ProviderThrottled,
  InvalidRecipient,
  IsoDateTimeSchema,
  RecipientUnavailable,
  UnknownProviderOutcome,
  type ProviderSendInput,
  type ProviderSendError,
  type NormalizedDeliveryEvent,
  type ReadyProvider,
  type SendAccepted,
} from "../src/providers/contract.js";
import {
  DeliveryJob,
  deliveryQueue,
  type DeliveryJob as DeliveryJobType,
} from "../src/queue/jobs.js";
import {
  challengeIdFrom,
  startPostgres,
  startRuntime,
  type IntegrationRuntime,
  type PostgresFixture,
} from "./fixture.js";

type ProviderOutcome =
  | "accepted"
  | "rejected"
  | "throttled"
  | "configuration-rejected"
  | "invalid-recipient"
  | "unknown"
  | "blocked-accepted";

interface ProviderControl {
  outcome: ProviderOutcome;
  readonly sends: ProviderSendInput[];
  started: PromiseWithResolvers<void> | undefined;
  release: PromiseWithResolvers<void> | undefined;
}

const makeControl = (): ProviderControl => ({
  outcome: "accepted",
  sends: [],
  started: undefined,
  release: undefined,
});

const resetControl = (control: ProviderControl): void => {
  control.outcome = "accepted";
  control.sends.length = 0;
  control.started = undefined;
  control.release = undefined;
};

const sendOutcome = (
  id: string,
  input: ProviderSendInput,
  control: ProviderControl,
  outcome: ProviderOutcome,
): Effect.Effect<SendAccepted, ProviderSendError> => {
  switch (outcome) {
    case "accepted":
      return Effect.succeed({
        providerRequestId: `${id}:${input.deliveryId}`,
        acceptanceEvidence: "integration_fake_accepted",
      });
    case "rejected":
      return Effect.fail(
        new RecipientUnavailable({
          acceptance: "not_accepted",
          diagnosticCode: "integration_fake_rejected",
        }),
      );
    case "throttled":
      return Effect.fail(
        new ProviderThrottled({
          acceptance: "not_accepted",
          diagnosticCode: "integration_fake_throttled",
          retryAt: Schema.decodeUnknownSync(IsoDateTimeSchema)("2099-01-01T00:00:00.000Z"),
        }),
      );
    case "configuration-rejected":
      return Effect.fail(
        new ProviderConfigurationRejected({
          acceptance: "not_accepted",
          diagnosticCode: "integration_fake_configuration_rejected",
        }),
      );
    case "invalid-recipient":
      return Effect.fail(
        new InvalidRecipient({
          acceptance: "not_accepted",
          diagnosticCode: "integration_fake_invalid_recipient",
        }),
      );
    case "unknown":
      return Effect.fail(
        new UnknownProviderOutcome({
          acceptance: "unknown",
          diagnosticCode: "integration_fake_unknown",
        }),
      );
    case "blocked-accepted":
      return Effect.promise(() => control.release?.promise ?? Promise.resolve()).pipe(
        Effect.as({
          providerRequestId: `${id}:${input.deliveryId}`,
          acceptanceEvidence: "integration_fake_accepted",
        }),
      );
  }
};

const providerLayer = (id: string, channel: string, control: ProviderControl) => {
  const instanceId = Schema.decodeUnknownSync(ProviderInstanceIdSchema)(id);
  const provider: ReadyProvider = {
    instanceId,
    pluginId: "integration-fake",
    version: "1.0.0",
    contractVersion: ProviderContractVersion,
    channel,
    enabled: true,
    settingsFingerprint: `${id}-settings-v1`,
    constraints: { minCodeLength: 6, maxCodeLength: 8, minDeliveryWindowMs: 0 },
    defaultSendTimeoutMs: 5_000,
    sendTimeoutMs: 5_000,
    diagnosticCodes: [
      "integration_fake_rejected",
      "integration_fake_throttled",
      "integration_fake_configuration_rejected",
      "integration_fake_invalid_recipient",
      "integration_fake_unknown",
      "callback_failed",
    ],
    idempotency: { supported: false },
    resolveTemplate: (candidates) => {
      const locale = candidates[0];
      return locale === undefined
        ? Effect.die(new Error("Integration configuration omitted its locale"))
        : Effect.succeed({ locale, template: null });
    },
    send: (input) =>
      Effect.sync(() => {
        control.sends.push(input);
        control.started?.resolve();
        return control.outcome;
      }).pipe(Effect.flatMap((outcome) => sendOutcome(id, input, control, outcome))),
  };
  return Layer.succeed(ProviderInstance, provider);
};

const key = (byte: number): string => Buffer.alloc(32, byte).toString("base64url");
const apiKey = "integration-api-key-that-is-at-least-32-bytes";
const primary = makeControl();
const secondary = makeControl();
const tertiary = makeControl();

const configuration = {
  settings: {
    crypto: {
      deploymentId: "integration",
      encryption: { active: "enc-v1", keys: { "enc-v1": key(1) } },
      verification: { active: "verify-v1", keys: { "verify-v1": key(2) } },
      fingerprint: { active: "fingerprint-v1", keys: { "fingerprint-v1": key(3) } },
      recipientKey: key(4),
    },
    apiKeys: [apiKey],
    defaultLocale: "en",
    fallbackLocales: [],
    policies: {
      default: {
        providerInstanceIds: ["fake-primary", "fake-secondary"],
        codeLength: 6,
        lifetimeSeconds: 300,
        maxIncorrectGuesses: 3,
        maxSends: 6,
        resendCooldownSeconds: 30,
        manualSelectionEnabled: true,
      },
    },
    purposes: { login: ["default"] },
    deploymentSendLimit15m: 100,
    deploymentSendLimit24h: 1_000,
    recipientCreateLimit15m: 2,
    recipientSendLimit15m: 10,
    recipientGuessLimit15m: 10,
  },
  providers: [
    providerLayer("fake-primary", "fake", primary),
    providerLayer("fake-secondary", "sms", secondary),
  ],
} as const;

let postgres: PostgresFixture | undefined;
let runtime: IntegrationRuntime | undefined;
let web: ReturnType<typeof makeWebHandler> | undefined;

const currentRuntime = (): IntegrationRuntime => {
  if (runtime === undefined) throw new Error("Integration runtime is not initialized");
  return runtime;
};

const createInput = (phoneNumber = "+998901234567"): CreateInput => ({
  recipient: { type: "phone", phoneNumber },
  purpose: "login",
  contextId: "session-1",
  policyId: "default",
});

const create = (
  operationKey: string = randomUUID(),
  phoneNumber?: string,
): Promise<OperationResult> => {
  const harness = currentRuntime();
  return Effect.runPromise(
    harness.router.create({
      key: operationKey,
      input: createInput(phoneNumber),
      requestId: randomUUID(),
    }),
  );
};

const deliveryFromCreated = (result: OperationResult): string => {
  if (!("delivery" in result.body)) throw new Error("Expected a challenge snapshot");
  return result.body.delivery.deliveryId;
};

const fetchJob = async (): Promise<{ readonly id: string; readonly data: DeliveryJobType }> => {
  const jobs = await currentRuntime().queue.fetch<unknown>(deliveryQueue, { batchSize: 1 });
  const job = jobs[0];
  if (job === undefined) throw new Error("Expected a queued delivery job");
  const data = Schema.decodeUnknownSync(DeliveryJob)(job.data);
  return { id: job.id, data };
};

const dispatchNext = async (
  config: RuntimeConfiguration = currentRuntime().configuration,
): Promise<DeliveryJobType> => {
  const harness = currentRuntime();
  const job = await fetchJob();
  await harness.run(dispatch(config, job.data));
  await harness.queue.complete(deliveryQueue, job.id);
  return job.data;
};

const query = <A, I>(schema: Schema.Codec<A, I>, text: string): Promise<ReadonlyArray<A>> => {
  const harness = currentRuntime();
  return harness.run(rows(schema, harness.pg.unsafe(text)));
};

const execute = (text: string): Promise<void> => {
  const harness = currentRuntime();
  return harness.run(harness.pg.unsafe(text).pipe(Effect.asVoid));
};

const callbackEvent = (
  deduplicationKey: string,
  correlationReference: string,
  status: NormalizedDeliveryEvent["status"],
): NormalizedDeliveryEvent => ({ deduplicationKey, correlationReference, status });

const withSettings = (changes: Partial<RuntimeConfiguration["settings"]>): RuntimeConfiguration => {
  const base = currentRuntime().configuration;
  return { ...base, settings: { ...base.settings, ...changes } };
};

const withProviderIdempotency = (
  config: RuntimeConfiguration,
  providerInstanceId: string,
): RuntimeConfiguration => {
  const providers = new Map(config.providers);
  const provider = providers.get(providerInstanceId);
  if (provider === undefined) throw new Error(`Expected provider ${providerInstanceId}`);
  providers.set(providerInstanceId, {
    ...provider,
    idempotency: {
      supported: true,
      keyScope: "delivery",
      retention: "integration-test",
      deduplicationEvidence: "provider-request-id",
    },
  });
  return { ...config, providers };
};

const createDirect = (
  config: RuntimeConfiguration,
  operationKey: string,
  input: CreateInput = createInput(),
) =>
  currentRuntime().run(
    createChallenge(config, { key: operationKey, input, requestId: randomUUID() }),
  );

const Counts = Schema.Struct({ count: Schema.Int });
const count = async (table: string): Promise<number> => {
  if (!/^[a-z_]+$/u.test(table)) throw new Error("Unsafe integration table name");
  const result = await query(Counts, `SELECT count(*)::integer AS count FROM otp_router.${table}`);
  const first = result[0];
  if (first === undefined) throw new Error("Expected a count row");
  return first.count;
};

const waitForChallengeRowWaiter = async (): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const waiting = await query(
      Counts,
      "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%FROM otp_router.challenges%FOR UPDATE%'",
    );
    if (waiting[0]?.count !== 0) return;
    await Effect.runPromise(Effect.yieldNow);
  }
  throw new Error("Verification did not reach the challenge row lock");
};

const readCode = async (challengeId: string): Promise<string> => {
  const harness = currentRuntime();
  const Secrets = Schema.Struct({ code: Schema.Unknown });
  const secret = await harness.run(
    single(
      Secrets,
      harness.pg.unsafe("SELECT code FROM otp_router.challenge_secrets WHERE challenge_id = $1", [
        challengeId,
      ]),
    ),
  );
  const Ciphertext = Schema.Struct({
    version: Schema.Literal(1),
    keyId: Schema.String,
    nonce: Schema.String,
    ciphertext: Schema.String,
    tag: Schema.String,
  });
  const encrypted = Schema.decodeUnknownSync(Ciphertext)(secret.code);
  return Effect.runPromise(
    decrypt(harness.configuration.settings.crypto, challengeId, "code", encrypted),
  );
};

beforeAll(async () => {
  postgres = await startPostgres();
  try {
    runtime = await startRuntime(postgres.databaseUrl, configuration);
    web = makeWebHandler(
      { apiKeys: [apiKey] },
      {
        router: runtime.router,
        webhooks: {
          handshake: () => Effect.fail(new WebhookError({ code: "unknown_instance" })),
          ingest: () => Effect.fail(new WebhookError({ code: "unknown_instance" })),
        },
      },
    );
  } catch (error) {
    await postgres.close();
    throw error;
  }
}, 120_000);

afterAll(async () => {
  await web?.dispose();
  await runtime?.close();
  await postgres?.close();
});

beforeEach(async () => {
  resetControl(primary);
  resetControl(secondary);
  resetControl(tertiary);
  await currentRuntime().reset();
});

describe("PostgreSQL integration", () => {
  it("runs HTTP create, queued dispatch, and verification end to end", async () => {
    if (web === undefined) throw new Error("HTTP handler is not initialized");
    const createResponse = await web.handler(
      new Request("http://localhost/v1/challenges", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": "http-create-1",
        },
        body: JSON.stringify(createInput()),
      }),
    );
    expect(createResponse.status).toBe(201);
    const created = Schema.decodeUnknownSync(Snapshot)(await createResponse.json());
    expect(created.delivery.state).toBe("pending");

    await dispatchNext();
    expect(primary.sends).toHaveLength(1);
    const code = primary.sends[0]?.code;
    if (code === undefined) throw new Error("The provider did not receive the code");
    const verifyResponse = await web.handler(
      new Request(`http://localhost/v1/challenges/${created.challengeId}/verify`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": "http-verify-1",
        },
        body: JSON.stringify({ code, purpose: "login", contextId: "session-1" }),
      }),
    );
    expect(verifyResponse.status).toBe(200);
    expect(Schema.decodeUnknownSync(VerificationResult)(await verifyResponse.json())).toMatchObject(
      {
        challengeId: created.challengeId,
        purpose: "login",
        contextId: "session-1",
      },
    );
    expect(await count("challenge_secrets")).toBe(0);
  });

  it("returns a generic HTTP 500 for defects without leaking details or writing state", async () => {
    const harness = currentRuntime();
    const defective = makeWebHandler(
      { apiKeys: [apiKey] },
      {
        router: {
          ...harness.router,
          create: () => Effect.die(new Error("private-provider-payload")),
        },
        webhooks: {
          handshake: () => Effect.fail(new WebhookError({ code: "unknown_instance" })),
          ingest: () => Effect.fail(new WebhookError({ code: "unknown_instance" })),
        },
      },
    );
    try {
      const response = await defective.handler(
        new Request("http://localhost/v1/challenges", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": "http-defect-create",
          },
          body: JSON.stringify(createInput()),
        }),
      );
      const text = await response.text();
      const body = Schema.decodeUnknownSync(
        Schema.Struct({
          error: Schema.Struct({
            code: Schema.Literal("internal_error"),
            message: Schema.String,
            requestId: Schema.String,
          }),
        }),
      )(JSON.parse(text) as unknown);
      expect(response.status).toBe(500);
      expect(body.error.requestId.length).toBeGreaterThan(0);
      expect(text).not.toContain("private-provider-payload");
      expect(await count("challenges")).toBe(0);
      expect(await count("deliveries")).toBe(0);
      expect(await count("idempotency_records")).toBe(0);
    } finally {
      await defective.dispose();
    }
  });

  it("preserves idempotent replay while application API keys rotate", async () => {
    const nextApiKey = "integration-next-api-key-that-is-at-least-32-bytes";
    const dependencies = {
      router: currentRuntime().router,
      webhooks: {
        handshake: () => Effect.fail(new WebhookError({ code: "unknown_instance" })),
        ingest: () => Effect.fail(new WebhookError({ code: "unknown_instance" })),
      },
    };
    const overlap = makeWebHandler({ apiKeys: [apiKey, nextApiKey] }, dependencies);
    const afterRotation = makeWebHandler({ apiKeys: [nextApiKey] }, dependencies);
    const request = (credential: string) =>
      new Request("http://localhost/v1/challenges", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
          "idempotency-key": "api-key-rotation-create",
        },
        body: JSON.stringify(createInput()),
      });
    try {
      const created = await overlap.handler(request(apiKey));
      expect(created.status).toBe(201);
      const original = Schema.decodeUnknownSync(Snapshot)(await created.json());

      const overlapReplay = await overlap.handler(request(nextApiKey));
      expect(overlapReplay.status).toBe(201);
      expect(overlapReplay.headers.get("idempotency-replayed")).toBe("true");
      expect(Schema.decodeUnknownSync(Snapshot)(await overlapReplay.json())).toEqual(original);

      const postRotationReplay = await afterRotation.handler(request(nextApiKey));
      expect(postRotationReplay.status).toBe(201);
      expect(postRotationReplay.headers.get("idempotency-replayed")).toBe("true");
      expect(Schema.decodeUnknownSync(Snapshot)(await postRotationReplay.json())).toEqual(original);
      expect((await afterRotation.handler(request(apiKey))).status).toBe(401);
      expect(await count("challenges")).toBe(1);
      expect(await count("deliveries")).toBe(1);
    } finally {
      await overlap.dispose();
      await afterRotation.dispose();
    }
  });

  it("serializes concurrent create replay and rejects changed input", async () => {
    const operationKey = "concurrent-create";
    const [left, right] = await Promise.all([create(operationKey), create(operationKey)]);
    expect([left.replayed, right.replayed].sort((a, b) => Number(a) - Number(b))).toEqual([
      false,
      true,
    ]);
    expect(challengeIdFrom(left)).toBe(challengeIdFrom(right));
    expect(await count("challenges")).toBe(1);
    expect(await count("deliveries")).toBe(1);
    expect(await count("idempotency_records")).toBe(1);

    const conflict = await Effect.runPromise(
      Effect.result(
        currentRuntime().router.create({
          key: operationKey,
          input: createInput("+998909876543"),
          requestId: randomUUID(),
        }),
      ),
    );
    expect(conflict).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DomainError", code: "idempotency_conflict" },
    });
  });

  it("maps an operation advisory-lock timeout to request_in_progress", async () => {
    if (web === undefined) throw new Error("HTTP handler is not initialized");
    const created = await create();
    const challengeId = challengeIdFrom(created);
    const operationKey = "blocked-operation-lock";
    const identity = operationIdentity(
      currentRuntime().configuration.settings.crypto.deploymentId,
      "cancel",
      challengeId,
      operationKey,
    );
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = currentRuntime().run(
      currentRuntime().pg.withTransaction(
        currentRuntime().pg`SELECT pg_advisory_xact_lock(hashtextextended(${identity},0))`.pipe(
          Effect.tap(() => Effect.sync(() => acquired.resolve())),
          Effect.andThen(Effect.promise(() => release.promise)),
        ),
      ),
    );
    await acquired.promise;
    try {
      const response = await web.handler(
        new Request(`http://localhost/v1/challenges/${challengeId}/cancel`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": operationKey,
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "request_in_progress" } });
    } finally {
      release.resolve();
      await blocker;
    }
    expect(
      await query(
        Schema.Struct({ verification_state: Schema.String }),
        `SELECT verification_state FROM otp_router.challenges WHERE id = '${challengeId}'`,
      ),
    ).toEqual([{ verification_state: "active" }]);
    expect(
      await query(
        Counts,
        `SELECT count(*)::integer AS count FROM otp_router.idempotency_records WHERE identity = '${identity}'`,
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("maps a non-operation database lock timeout to HTTP 503", async () => {
    if (web === undefined) throw new Error("HTTP handler is not initialized");
    const created = await create();
    const challengeId = challengeIdFrom(created);
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = currentRuntime().run(
      currentRuntime().pg.withTransaction(
        currentRuntime()
          .pg`SELECT id FROM otp_router.challenges WHERE id::text = ${challengeId} FOR UPDATE`.pipe(
          Effect.tap(() => Effect.sync(() => acquired.resolve())),
          Effect.andThen(Effect.promise(() => release.promise)),
        ),
      ),
    );
    await acquired.promise;
    try {
      const response = await web.handler(
        new Request(`http://localhost/v1/challenges/${challengeId}/cancel`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": "blocked-challenge-row",
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "temporarily_unavailable" },
      });
    } finally {
      release.resolve();
      await blocker;
    }
  });

  it.each(["create", "verify", "dispatch"] as const)(
    "fails %s closed while the recipient quota is locked",
    async (operation) => {
      const harness = currentRuntime();
      const created = await create("quota-lock-existing");
      const challengeId = challengeIdFrom(created);
      const code = await readCode(challengeId);
      const job = await fetchJob();
      const tokenRows = await harness.run(
        rows(
          Schema.Struct({ recipient_token: Schema.String }),
          harness.pg`SELECT recipient_token FROM otp_router.challenges WHERE id::text = ${challengeId}`,
        ),
      );
      const recipientToken = tokenRows[0]?.recipient_token;
      if (recipientToken === undefined) throw new Error("Expected the recipient quota token");
      const quotaIdentity = `recipient:${recipientToken}`;
      const createRequest = {
        key: "quota-lock-new-create",
        input: { ...createInput(), contextId: "quota-lock-new-flow" },
        requestId: randomUUID(),
      };
      const verifyRequest = {
        key: "quota-lock-verify",
        challengeId,
        input: { code, purpose: "login", contextId: "session-1" },
        requestId: randomUUID(),
      };
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = harness.run(
        harness.pg.withTransaction(
          harness.pg`SELECT identity FROM otp_router.quota_keys WHERE identity = ${quotaIdentity} FOR UPDATE`.pipe(
            Effect.tap(() => Effect.sync(() => entered.resolve())),
            Effect.andThen(Effect.promise(() => release.promise)),
          ),
        ),
      );
      await entered.promise;
      const outcome = await (async () => {
        try {
          switch (operation) {
            case "create":
              return await Effect.runPromise(Effect.result(harness.router.create(createRequest)));
            case "verify":
              return await Effect.runPromise(Effect.result(harness.router.verify(verifyRequest)));
            case "dispatch":
              return await harness.run(Effect.result(dispatch(harness.configuration, job.data)));
          }
        } finally {
          release.resolve();
          await blocker;
        }
      })();
      expect(outcome).toMatchObject(
        operation === "dispatch"
          ? { _tag: "Failure", failure: { _tag: "SqlError" } }
          : { _tag: "Failure", failure: { code: "temporarily_unavailable" } },
      );
      expect(primary.sends).toHaveLength(0);
      expect(await count("challenges")).toBe(1);
      expect(await count("deliveries")).toBe(1);
      expect(await count("idempotency_records")).toBe(1);
      expect(
        await query(
          Schema.Struct({
            verification_state: Schema.String,
            incorrect_guesses: Schema.Int,
            send_count: Schema.Int,
          }),
          `SELECT verification_state, incorrect_guesses, send_count FROM otp_router.challenges WHERE id = '${challengeId}'`,
        ),
      ).toEqual([{ verification_state: "active", incorrect_guesses: 0, send_count: 0 }]);
      expect(
        await query(
          Schema.Struct({ state: Schema.String }),
          `SELECT state FROM otp_router.deliveries WHERE id = '${job.data.deliveryId}'`,
        ),
      ).toEqual([{ state: "pending" }]);
      expect(
        await harness.run(
          rows(
            Counts,
            harness.pg`SELECT count(*)::integer AS count FROM pgboss.job WHERE name = ${deliveryQueue}`,
          ),
        ),
      ).toEqual([{ count: 1 }]);
      expect(
        await query(
          Counts,
          "SELECT count(*)::integer AS count FROM otp_router.quota_events WHERE kind IN ('guess','send')",
        ),
      ).toEqual([{ count: 0 }]);

      const retriedCreate = await Effect.runPromise(
        harness.router.create({ ...createRequest, requestId: randomUUID() }),
      );
      await harness.run(dispatch(harness.configuration, job.data));
      const retriedVerify = await Effect.runPromise(
        harness.router.verify({ ...verifyRequest, requestId: randomUUID() }),
      );
      expect(retriedCreate).toMatchObject({ status: 201, replayed: false });
      expect(retriedVerify).toMatchObject({ status: 200, replayed: false });
      expect(primary.sends).toHaveLength(1);
    },
  );

  it("allows one winner when correct verification races", async () => {
    const created = await create();
    const challengeId = challengeIdFrom(created);
    const code = await readCode(challengeId);
    const verify = (keyValue: string) =>
      Effect.runPromise(
        Effect.result(
          currentRuntime().router.verify({
            key: keyValue,
            challengeId,
            requestId: randomUUID(),
            input: { code, purpose: "login", contextId: "session-1" },
          }),
        ),
      );
    const outcomes = await Promise.all([verify("verify-race-a"), verify("verify-race-b")]);
    expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome._tag === "Failure")).toMatchObject([
      { failure: { code: "challenge_state_conflict" } },
    ]);
    expect(await count("challenge_secrets")).toBe(0);
    const verificationRows = await query(
      Counts,
      "SELECT count(*)::integer AS count FROM otp_router.challenges WHERE verification_id IS NOT NULL",
    );
    expect(verificationRows[0]?.count).toBe(1);
  });

  it("does not send fallback when correct verification races a definitive outcome", async () => {
    const harness = currentRuntime();
    const created = await create("verify-versus-fallback");
    const challengeId = challengeIdFrom(created);
    const code = await readCode(challengeId);
    const oldJob = await fetchJob();
    expect(await harness.run(dispatchGate(harness.configuration, oldJob.data))).toBeDefined();

    await Promise.all([
      Effect.runPromise(
        harness.router.verify({
          key: "verify-versus-fallback-correct",
          challengeId,
          requestId: randomUUID(),
          input: { code, purpose: "login", contextId: "session-1" },
        }),
      ),
      harness.run(
        recordOutcome(harness.configuration, oldJob.data.deliveryId, {
          state: "failed",
          acceptance: "not_accepted",
          diagnosticCode: "RecipientUnavailable",
        }),
      ),
    ]);

    await harness.run(dispatch(harness.configuration, oldJob.data));
    await harness.queue.complete(deliveryQueue, oldJob.id);
    const queued = await harness.queue.fetch<unknown>(deliveryQueue, { batchSize: 10 });
    for (const job of queued) {
      const data = Schema.decodeUnknownSync(DeliveryJob)(job.data);
      await harness.run(dispatch(harness.configuration, data));
      await harness.queue.complete(deliveryQueue, job.id);
    }

    expect(primary.sends).toHaveLength(0);
    expect(secondary.sends).toHaveLength(0);
    expect(await count("challenge_secrets")).toBe(0);
    expect(
      await query(
        Schema.Struct({
          verification_state: Schema.String,
          verification_count: Schema.Int,
        }),
        `SELECT verification_state, CASE WHEN verification_id IS NULL THEN 0 ELSE 1 END::integer AS verification_count FROM otp_router.challenges WHERE id = '${challengeId}'`,
      ),
    ).toEqual([{ verification_state: "verified", verification_count: 1 }]);
    expect(
      await query(
        Counts,
        "SELECT count(*)::integer AS count FROM otp_router.deliveries WHERE state IN ('pending','dispatching')",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("replays successful verification after erasure without comparing a changed code", async () => {
    const created = await create();
    const challengeId = challengeIdFrom(created);
    const code = await readCode(challengeId);
    const request = {
      key: "successful-verify-replay",
      challengeId,
      requestId: randomUUID(),
      input: { code, purpose: "login", contextId: "session-1" },
    } as const;
    const first = await Effect.runPromise(currentRuntime().router.verify(request));
    const replayed = await Effect.runPromise(
      currentRuntime().router.verify({ ...request, requestId: randomUUID() }),
    );
    expect(first.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(replayed.body).toEqual(first.body);
    const changed = await Effect.runPromise(
      Effect.result(
        currentRuntime().router.verify({
          ...request,
          requestId: randomUUID(),
          input: { ...request.input, code: code === "000000" ? "000001" : "000000" },
        }),
      ),
    );
    expect(changed).toMatchObject({
      _tag: "Success",
      success: { replayed: true, body: first.body },
    });
    expect(await count("challenge_secrets")).toBe(0);
  });

  it("replays a wrong guess without consuming another guess and locks at the limit", async () => {
    const created = await create();
    const challengeId = challengeIdFrom(created);
    const code = await readCode(challengeId);
    const firstWrong = code === "999999" ? "999998" : "999999";
    const changedWrong = code === "888888" ? "888887" : "888888";
    const verifyWrong = (keyValue: string, submittedCode = firstWrong) =>
      Effect.runPromise(
        currentRuntime().router.verify({
          key: keyValue,
          challengeId,
          requestId: randomUUID(),
          input: { code: submittedCode, purpose: "login", contextId: "session-1" },
        }),
      );
    const first = await verifyWrong("wrong-1");
    const replayed = await verifyWrong("wrong-1");
    expect(first.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(
      await Effect.runPromise(
        Effect.result(
          currentRuntime().router.verify({
            key: "wrong-1",
            challengeId,
            requestId: randomUUID(),
            input: { code: changedWrong, purpose: "login", contextId: "session-1" },
          }),
        ),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "idempotency_conflict" } });
    expect(
      await query(
        Schema.Struct({ incorrect_guesses: Schema.Int }),
        `SELECT incorrect_guesses FROM otp_router.challenges WHERE id = '${challengeId}'`,
      ),
    ).toEqual([{ incorrect_guesses: 1 }]);
    await verifyWrong("wrong-2");
    const locked = await verifyWrong("wrong-3");
    expect(locked.body).toMatchObject({
      error: { code: "incorrect_code", verificationState: "locked" },
    });
    const state = await query(
      Schema.Struct({ incorrect_guesses: Schema.Int, verification_state: Schema.String }),
      "SELECT incorrect_guesses, verification_state FROM otp_router.challenges",
    );
    expect(state).toEqual([{ incorrect_guesses: 3, verification_state: "locked" }]);
    expect(await count("challenge_secrets")).toBe(0);
  });

  it("cancels once, replays cancellation, and suppresses queued delivery", async () => {
    const created = await create();
    const challengeId = challengeIdFrom(created);
    const request = {
      key: "cancel-replay",
      challengeId,
      requestId: randomUUID(),
      input: {},
    } as const;
    const cancelled = await Effect.runPromise(currentRuntime().router.cancel(request));
    const replayed = await Effect.runPromise(
      currentRuntime().router.cancel({ ...request, requestId: randomUUID() }),
    );
    expect(cancelled.body).toMatchObject({ verificationState: "cancelled" });
    expect(replayed.replayed).toBe(true);
    expect(replayed.body).toEqual(cancelled.body);
    expect(await count("challenge_secrets")).toBe(0);
    expect(
      await query(
        Schema.Struct({ state: Schema.String }),
        "SELECT state FROM otp_router.deliveries",
      ),
    ).toEqual([{ state: "suppressed" }]);
    const job = await fetchJob();
    await currentRuntime().run(dispatch(currentRuntime().configuration, job.data));
    expect(primary.sends).toHaveLength(0);
  });

  it("does not complete a cooldown-rejected operation key and accepts its later retry", async () => {
    const created = await create("cooldown-retry-create");
    const challengeId = challengeIdFrom(created);
    const operationKey = "cooldown-retry-deliver";
    const request = {
      key: operationKey,
      challengeId,
      requestId: randomUUID(),
      input: { action: "resend" as const },
    };
    expect(
      await Effect.runPromise(Effect.result(currentRuntime().router.deliver(request))),
    ).toMatchObject({ _tag: "Failure", failure: { code: "cooldown_active" } });
    const identity = operationIdentity(
      currentRuntime().configuration.settings.crypto.deploymentId,
      "deliver",
      challengeId,
      operationKey,
    );
    expect(
      await query(
        Counts,
        `SELECT count(*)::integer AS count FROM otp_router.idempotency_records WHERE identity = '${identity}'`,
      ),
    ).toEqual([{ count: 0 }]);

    await currentRuntime().run(
      currentRuntime()
        .pg`UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id::text = ${challengeId}`,
    );
    const accepted = await Effect.runPromise(
      currentRuntime().router.deliver({ ...request, requestId: randomUUID() }),
    );
    expect(accepted).toMatchObject({ status: 202, replayed: false });
    expect(
      await query(
        Counts,
        `SELECT count(*)::integer AS count FROM otp_router.idempotency_records WHERE identity = '${identity}'`,
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("does not complete a quota-rejected operation key and accepts it after the window", async () => {
    const harness = currentRuntime();
    const config = withSettings({ providerSendLimits15m: { "fake-primary": 1 } });
    const created = await createDirect(config, "quota-retry-create");
    const challengeId = challengeIdFrom(created);
    const eventId = randomUUID();
    await harness.run(
      harness.pg`INSERT INTO otp_router.quota_keys(identity) VALUES ('provider:fake-primary') ON CONFLICT DO NOTHING`,
    );
    await harness.run(
      harness.pg`INSERT INTO otp_router.quota_events(identity,kind,event_id,occurred_at) VALUES ('provider:fake-primary','send',${eventId},clock_timestamp())`,
    );
    await harness.run(
      harness.pg`UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id::text = ${challengeId}`,
    );
    const operationKey = "quota-retry-deliver";
    const request = {
      key: operationKey,
      challengeId,
      requestId: randomUUID(),
      input: { action: "resend" as const },
    };
    expect(await harness.run(Effect.result(requestDelivery(config, request)))).toMatchObject({
      _tag: "Failure",
      failure: { code: "rate_limited" },
    });
    const identity = operationIdentity(
      config.settings.crypto.deploymentId,
      "deliver",
      challengeId,
      operationKey,
    );
    expect(
      await query(
        Counts,
        `SELECT count(*)::integer AS count FROM otp_router.idempotency_records WHERE identity = '${identity}'`,
      ),
    ).toEqual([{ count: 0 }]);

    await harness.run(
      harness.pg`UPDATE otp_router.quota_events SET occurred_at = clock_timestamp() - interval '15 minutes 1 second' WHERE event_id = ${eventId}`,
    );
    const accepted = await harness.run(
      requestDelivery(config, { ...request, requestId: randomUUID() }),
    );
    expect(accepted).toMatchObject({ status: 202, replayed: false });
    expect(
      await query(
        Counts,
        `SELECT count(*)::integer AS count FROM otp_router.idempotency_records WHERE identity = '${identity}'`,
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("atomically enforces recipient create quotas across concurrent challenges", async () => {
    const attempts = await Promise.all(
      ["quota-create-1", "quota-create-2", "quota-create-3"].map((operationKey) =>
        Effect.runPromise(
          Effect.result(
            currentRuntime().router.create({
              key: operationKey,
              input: createInput(),
              requestId: randomUUID(),
            }),
          ),
        ),
      ),
    );
    expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt._tag === "Failure")).toMatchObject([
      { failure: { _tag: "DomainError", code: "rate_limited" } },
    ]);
    expect(await count("challenges")).toBe(2);
  });

  it("keeps recipient quota usage after challenge history is deleted", async () => {
    const first = await create("quota-history-1");
    const second = await create("quota-history-2");
    await execute(
      `DELETE FROM otp_router.challenges WHERE id IN ('${challengeIdFrom(first)}', '${challengeIdFrom(second)}')`,
    );

    const result = await currentRuntime().run(
      Effect.result(
        createChallenge(currentRuntime().configuration, {
          key: "quota-history-3",
          input: createInput(),
          requestId: randomUUID(),
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "rate_limited" },
    });
    expect(await count("challenges")).toBe(0);
    expect(
      await query(
        Counts,
        "SELECT count(*)::integer AS count FROM otp_router.quota_events WHERE kind = 'create'",
      ),
    ).toEqual([{ count: 2 }]);
  });

  it("reserves one send when two workers race the same delivery", async () => {
    const created = await create();
    const job = await fetchJob();
    primary.outcome = "blocked-accepted";
    primary.started = Promise.withResolvers<void>();
    primary.release = Promise.withResolvers<void>();
    const first = currentRuntime().run(dispatch(currentRuntime().configuration, job.data));
    await primary.started.promise;
    const second = currentRuntime().run(dispatch(currentRuntime().configuration, job.data));
    await second;
    primary.release.resolve();
    await first;
    expect(primary.sends).toHaveLength(1);
    const delivery = await query(
      Schema.Struct({ state: Schema.String, acceptance: Schema.NullOr(Schema.String) }),
      "SELECT state, acceptance FROM otp_router.deliveries",
    );
    expect(delivery).toEqual([{ state: "accepted", acceptance: "accepted" }]);
    const challenge = await query(
      Schema.Struct({ send_count: Schema.Int }),
      `SELECT send_count FROM otp_router.challenges WHERE id = '${challengeIdFrom(created)}'`,
    );
    expect(challenge[0]?.send_count).toBe(1);
  });

  it("does not retry an uncertain idempotency-capable provider on duplicate dispatch", async () => {
    const harness = currentRuntime();
    const config = withProviderIdempotency(harness.configuration, "fake-primary");
    const created = await createDirect(config, "idempotent-unknown-create");
    const job = await fetchJob();
    primary.outcome = "unknown";

    await harness.run(dispatch(config, job.data));
    await harness.run(dispatch(config, job.data));

    expect(primary.sends).toHaveLength(1);
    expect(primary.sends[0]).toMatchObject({
      deliveryId: deliveryFromCreated(created),
      providerIdempotencyKey: deliveryFromCreated(created),
    });
    expect(
      await query(
        Schema.Struct({ state: Schema.String, acceptance: Schema.String }),
        "SELECT state, acceptance FROM otp_router.deliveries",
      ),
    ).toEqual([{ state: "uncertain", acceptance: "unknown" }]);
    expect(
      await query(
        Schema.Struct({ send_count: Schema.Int }),
        `SELECT send_count FROM otp_router.challenges WHERE id = '${challengeIdFrom(created)}'`,
      ),
    ).toEqual([{ send_count: 1 }]);
  });

  it.each(["defect", "interruption"] as const)(
    "keeps a rejection combined with a finalizer %s uncertain",
    async (failureKind) => {
      const harness = currentRuntime();
      const providers = new Map(harness.configuration.providers);
      const original = providers.get("fake-primary");
      if (original === undefined) throw new Error("Expected the primary provider");
      let invocations = 0;
      providers.set("fake-primary", {
        ...original,
        send: () =>
          Effect.sync(() => {
            invocations += 1;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new RecipientUnavailable({
                  acceptance: "not_accepted",
                  diagnosticCode: "integration_fake_rejected",
                }),
              ),
            ),
            Effect.ensuring(
              failureKind === "defect"
                ? Effect.die(new Error("finalizer failed"))
                : Effect.interrupt,
            ),
          ),
      });
      const config: RuntimeConfiguration = { ...harness.configuration, providers };
      await createDirect(config, "mixed-provider-failure");
      const job = await fetchJob();
      const exit = await harness.run(dispatch(config, job.data).pipe(Effect.exit));
      if (Exit.isSuccess(exit)) throw new Error("Expected the provider cause to propagate");
      expect(Cause.findErrorOption(exit.cause)).toMatchObject({
        _tag: "Some",
        value: { _tag: "RecipientUnavailable" },
      });
      expect(
        failureKind === "defect" ? Cause.hasDies(exit.cause) : Cause.hasInterrupts(exit.cause),
      ).toBe(true);
      await harness.run(dispatch(config, job.data));
      expect(invocations).toBe(1);
      expect(secondary.sends).toHaveLength(0);
      expect(
        await query(
          Schema.Struct({ state: Schema.String, acceptance: Schema.String }),
          "SELECT state, acceptance FROM otp_router.deliveries",
        ),
      ).toEqual([{ state: "uncertain", acceptance: "unknown" }]);
      expect(
        await query(
          Schema.Struct({ send_count: Schema.Int }),
          "SELECT send_count FROM otp_router.challenges",
        ),
      ).toEqual([{ send_count: 1 }]);
    },
  );

  it("enforces an instance timeout and keeps a never-completing send uncertain", async () => {
    const harness = currentRuntime();
    const providers = new Map(harness.configuration.providers);
    const original = providers.get("fake-primary");
    const secondaryProvider = providers.get("fake-secondary");
    if (original === undefined || secondaryProvider === undefined)
      throw new Error("Expected both integration providers");
    let invocations = 0;
    providers.set("fake-primary", {
      ...original,
      sendTimeoutMs: 20,
      send: (input) =>
        Effect.sync(() => {
          invocations += 1;
          primary.sends.push(input);
        }).pipe(Effect.andThen(Effect.never)),
    });
    const config: RuntimeConfiguration = { ...harness.configuration, providers };
    const created = await createDirect(config, "provider-timeout-create");
    const job = await fetchJob();
    expect(
      await query(
        Schema.Struct({ primary_timeout: Schema.Int, secondary_timeout: Schema.Int }),
        "SELECT (snapshot->'providers'->0->>'sendTimeoutMs')::integer AS primary_timeout, (snapshot->'providers'->1->>'sendTimeoutMs')::integer AS secondary_timeout FROM otp_router.challenges",
      ),
    ).toEqual([
      {
        primary_timeout: 20,
        secondary_timeout: secondaryProvider.defaultSendTimeoutMs,
      },
    ]);

    await harness.run(dispatch(config, job.data));
    await harness.run(dispatch(config, job.data));

    expect(invocations).toBe(1);
    expect(primary.sends).toHaveLength(1);
    expect(secondary.sends).toHaveLength(0);
    expect(
      await query(
        Schema.Struct({
          state: Schema.String,
          acceptance: Schema.String,
          diagnostic_code: Schema.String,
        }),
        "SELECT state, acceptance, diagnostic_code FROM otp_router.deliveries",
      ),
    ).toEqual([
      {
        state: "uncertain",
        acceptance: "unknown",
        diagnostic_code: "interrupted_or_timeout",
      },
    ]);
    expect(
      await query(
        Schema.Struct({ send_count: Schema.Int }),
        `SELECT send_count FROM otp_router.challenges WHERE id = '${challengeIdFrom(created)}'`,
      ),
    ).toEqual([{ send_count: 1 }]);
    expect(
      await query(
        Counts,
        "SELECT count(*)::integer AS count FROM otp_router.quota_events WHERE identity = 'deployment' AND kind = 'send'",
      ),
    ).toEqual([{ count: 1 }]);
    expect(await count("deliveries")).toBe(1);
  });

  it("does not invoke a provider when the dispatch transaction consumes the remaining budget", async () => {
    const harness = currentRuntime();
    const created = await create();
    const job = await fetchJob();
    await execute(`CREATE FUNCTION otp_router.hold_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(983451); RETURN NEW; END $$`);
    await execute(`CREATE TRIGGER hold_dispatch BEFORE UPDATE ON otp_router.deliveries FOR EACH ROW
      WHEN (NEW.state = 'dispatching') EXECUTE FUNCTION otp_router.hold_dispatch()`);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = harness.run(
      harness.pg.withTransaction(
        harness.pg`SELECT pg_advisory_xact_lock(983451)`.pipe(
          Effect.tap(() => Effect.sync(() => entered.resolve())),
          Effect.andThen(Effect.promise(() => release.promise)),
        ),
      ),
    );
    await entered.promise;
    const sending = harness.run(dispatch(harness.configuration, job.data));
    const originalNow = performance.now.bind(performance);
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (attempt === 1000) throw new Error("Dispatch did not reach its reservation barrier");
        const waiting = await query(
          Counts,
          "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE 'UPDATE otp_router.deliveries%'",
        );
        if ((waiting[0]?.count ?? 0) > 0) break;
        await Effect.runPromise(Effect.yieldNow);
      }
      vi.spyOn(performance, "now").mockImplementation(() => originalNow() + 600000);
      release.resolve();
      await sending;
      expect(primary.sends).toHaveLength(0);
      expect(
        await query(
          Schema.Struct({ state: Schema.String, diagnostic_code: Schema.String }),
          `SELECT state, diagnostic_code FROM otp_router.deliveries WHERE id = '${job.data.deliveryId}'`,
        ),
      ).toEqual([{ state: "failed", diagnostic_code: "delivery_window_too_short" }]);
      expect(
        await query(
          Schema.Struct({ send_count: Schema.Int }),
          `SELECT send_count FROM otp_router.challenges WHERE id = '${challengeIdFrom(created)}'`,
        ),
      ).toEqual([{ send_count: 1 }]);
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, sending]);
      vi.restoreAllMocks();
      await execute("DROP TRIGGER hold_dispatch ON otp_router.deliveries");
      await execute("DROP FUNCTION otp_router.hold_dispatch()");
    }
  });

  it("marks recovered dispatching work uncertain without invoking the provider", async () => {
    await create();
    const job = await fetchJob();
    await execute(
      `UPDATE otp_router.deliveries SET state = 'dispatching', acceptance = 'unknown', reserved_at = clock_timestamp() WHERE id = '${job.data.deliveryId}'`,
    );
    await currentRuntime().run(dispatch(currentRuntime().configuration, job.data));
    expect(primary.sends).toHaveLength(0);
    const delivery = await query(
      Schema.Struct({ state: Schema.String, diagnostic_code: Schema.NullOr(Schema.String) }),
      "SELECT state, diagnostic_code FROM otp_router.deliveries",
    );
    expect(delivery).toEqual([{ state: "uncertain", diagnostic_code: "worker_recovery" }]);
  });

  it("falls back after definitive rejection but preserves an uncertain outcome", async () => {
    primary.outcome = "rejected";
    await create("fallback-definitive");
    await dispatchNext();
    expect(primary.sends).toHaveLength(1);
    expect(await count("deliveries")).toBe(2);
    expect(
      await query(
        Schema.Struct({ reason: Schema.String, state: Schema.String }),
        "SELECT reason, state FROM otp_router.deliveries ORDER BY route_position",
      ),
    ).toEqual([
      { reason: "initial", state: "failed" },
      { reason: "fallback", state: "pending" },
    ]);

    await currentRuntime().reset();
    resetControl(primary);
    primary.outcome = "unknown";
    await create("fallback-uncertain");
    await dispatchNext();
    expect(await count("deliveries")).toBe(1);
    expect(
      await query(
        Schema.Struct({ state: Schema.String, acceptance: Schema.String }),
        "SELECT state, acceptance FROM otp_router.deliveries",
      ),
    ).toEqual([{ state: "uncertain", acceptance: "unknown" }]);
  });

  it("falls forward from an initially selected middle provider without route wraparound", async () => {
    const harness = currentRuntime();
    const providers = new Map(harness.configuration.providers);
    const second = providers.get("fake-secondary");
    const policy = harness.configuration.settings.policies["default"];
    if (second === undefined || policy === undefined)
      throw new Error("Expected the secondary provider and default policy");
    const tertiaryId = Schema.decodeUnknownSync(ProviderInstanceIdSchema)("fake-tertiary");
    providers.set("fake-tertiary", {
      ...second,
      instanceId: tertiaryId,
      settingsFingerprint: "fake-tertiary-settings-v1",
      send: (input) =>
        Effect.sync(() => {
          tertiary.sends.push(input);
          return tertiary.outcome;
        }).pipe(
          Effect.flatMap((outcome) => sendOutcome("fake-tertiary", input, tertiary, outcome)),
        ),
    });
    const config: RuntimeConfiguration = {
      ...harness.configuration,
      providers,
      settings: {
        ...harness.configuration.settings,
        policies: {
          ...harness.configuration.settings.policies,
          default: {
            ...policy,
            providerInstanceIds: ["fake-primary", "fake-secondary", "fake-tertiary"],
          },
        },
      },
    };
    secondary.outcome = "rejected";
    await createDirect(config, "middle-provider-create", {
      ...createInput(),
      deliveryChoice: { type: "provider", providerInstanceId: "fake-secondary" },
    });
    await dispatchNext(config);
    await dispatchNext(config);

    expect(primary.sends).toHaveLength(0);
    expect(secondary.sends).toHaveLength(1);
    expect(tertiary.sends).toHaveLength(1);
    expect(
      await query(
        Schema.Struct({ provider_instance_id: Schema.String, reason: Schema.String }),
        "SELECT provider_instance_id, reason FROM otp_router.deliveries ORDER BY route_position",
      ),
    ).toEqual([
      { provider_instance_id: "fake-secondary", reason: "initial" },
      { provider_instance_id: "fake-tertiary", reason: "fallback" },
    ]);
  });

  it("falls back on throttling but restricts later explicit use until retry time", async () => {
    const harness = currentRuntime();
    primary.outcome = "throttled";
    const created = await create("provider-throttled");
    const challengeId = challengeIdFrom(created);
    await dispatchNext();

    expect(primary.sends).toHaveLength(1);
    expect(
      await query(
        Schema.Struct({ provider_instance_id: Schema.String, retry_at: Schema.Date }),
        "SELECT provider_instance_id, retry_at FROM otp_router.provider_restrictions",
      ),
    ).toEqual([
      {
        provider_instance_id: "fake-primary",
        retry_at: new Date("2099-01-01T00:00:00.000Z"),
      },
    ]);
    expect(
      await query(
        Schema.Struct({ provider_instance_id: Schema.String, reason: Schema.String }),
        "SELECT provider_instance_id, reason FROM otp_router.deliveries ORDER BY route_position",
      ),
    ).toEqual([
      { provider_instance_id: "fake-primary", reason: "initial" },
      { provider_instance_id: "fake-secondary", reason: "fallback" },
    ]);
    await harness.run(
      harness.pg`UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id::text = ${challengeId}`,
    );
    const request = {
      key: "select-throttled-primary",
      challengeId,
      requestId: randomUUID(),
      input: {
        action: "select" as const,
        choice: { type: "provider" as const, providerInstanceId: "fake-primary" },
      },
    };
    expect(await Effect.runPromise(Effect.result(harness.router.deliver(request)))).toMatchObject({
      _tag: "Failure",
      failure: { code: "delivery_option_not_allowed" },
    });

    await harness.run(
      harness.pg`UPDATE otp_router.provider_restrictions SET retry_at = clock_timestamp() - interval '1 second' WHERE provider_instance_id = 'fake-primary'`,
    );
    const selected = await Effect.runPromise(
      harness.router.deliver({ ...request, requestId: randomUUID() }),
    );
    expect(selected).toMatchObject({ status: 202, replayed: false });
  });

  it("falls through after a definitive provider configuration rejection", async () => {
    primary.outcome = "configuration-rejected";
    await create("configuration-rejected-fallback");
    await dispatchNext();

    expect(primary.sends).toHaveLength(1);
    expect(secondary.sends).toHaveLength(0);
    expect(
      await query(
        Schema.Struct({
          provider_instance_id: Schema.String,
          state: Schema.String,
          failure_category: Schema.NullOr(Schema.String),
          diagnostic_code: Schema.NullOr(Schema.String),
        }),
        "SELECT provider_instance_id, state, failure_category, diagnostic_code FROM otp_router.deliveries ORDER BY route_position",
      ),
    ).toEqual([
      {
        provider_instance_id: "fake-primary",
        state: "failed",
        failure_category: "ProviderConfigurationRejected",
        diagnostic_code: "integration_fake_configuration_rejected",
      },
      {
        provider_instance_id: "fake-secondary",
        state: "pending",
        failure_category: null,
        diagnostic_code: null,
      },
    ]);
  });

  it("skips an emergency-disabled provider without reserving a send", async () => {
    const harness = currentRuntime();
    const created = await create("disabled-current-provider");
    const providers = new Map(harness.configuration.providers);
    const current = providers.get("fake-primary");
    if (current === undefined) throw new Error("Expected the primary provider");
    providers.set("fake-primary", { ...current, enabled: false });
    const config: RuntimeConfiguration = { ...harness.configuration, providers };

    await dispatchNext(config);
    expect(primary.sends).toHaveLength(0);
    expect(secondary.sends).toHaveLength(0);
    expect(
      await query(
        Schema.Struct({ send_count: Schema.Int }),
        `SELECT send_count FROM otp_router.challenges WHERE id = '${challengeIdFrom(created)}'`,
      ),
    ).toEqual([{ send_count: 0 }]);
    expect(
      await query(
        Counts,
        "SELECT count(*)::integer AS count FROM otp_router.quota_events WHERE kind = 'send'",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await query(
        Schema.Struct({
          provider_instance_id: Schema.String,
          state: Schema.String,
          diagnostic_code: Schema.NullOr(Schema.String),
        }),
        "SELECT provider_instance_id, state, diagnostic_code FROM otp_router.deliveries ORDER BY route_position",
      ),
    ).toEqual([
      {
        provider_instance_id: "fake-primary",
        state: "failed",
        diagnostic_code: "provider_unavailable",
      },
      {
        provider_instance_id: "fake-secondary",
        state: "pending",
        diagnostic_code: null,
      },
    ]);

    await dispatchNext(config);
    expect(secondary.sends).toHaveLength(1);
    expect(
      await query(
        Schema.Struct({ send_count: Schema.Int }),
        `SELECT send_count FROM otp_router.challenges WHERE id = '${challengeIdFrom(created)}'`,
      ),
    ).toEqual([{ send_count: 1 }]);
  });

  it("preserves verification but blocks every delivery action after invalid recipient", async () => {
    const created = await create("invalid-recipient-stop");
    const challengeId = challengeIdFrom(created);
    const code = await readCode(challengeId);
    primary.outcome = "invalid-recipient";
    await dispatchNext();

    expect(primary.sends).toHaveLength(1);
    expect(secondary.sends).toHaveLength(0);
    expect(await count("deliveries")).toBe(1);
    const status = await Effect.runPromise(currentRuntime().router.status(challengeId));
    expect(status.body).toMatchObject({
      verificationState: "active",
      actions: {
        verify: { allowed: true },
        resend: { allowed: false, reason: "delivery_unavailable" },
        next: { allowed: false, reason: "delivery_unavailable" },
        select: { allowed: false, reason: "delivery_unavailable" },
      },
    });

    for (const [operationKey, input] of [
      ["invalid-recipient-resend", { action: "resend" }],
      ["invalid-recipient-next", { action: "next" }],
      [
        "invalid-recipient-select",
        {
          action: "select",
          choice: { type: "provider", providerInstanceId: "fake-secondary" },
        },
      ],
    ] as const) {
      expect(
        await Effect.runPromise(
          Effect.result(
            currentRuntime().router.deliver({
              key: operationKey,
              challengeId,
              requestId: randomUUID(),
              input,
            }),
          ),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "delivery_unavailable" } });
    }
    expect(await count("deliveries")).toBe(1);
    expect(await count("challenge_secrets")).toBe(1);

    const verified = await Effect.runPromise(
      currentRuntime().router.verify({
        key: "verify-after-invalid-recipient",
        challengeId,
        requestId: randomUUID(),
        input: { code, purpose: "login", contextId: "session-1" },
      }),
    );
    expect(verified.status).toBe(200);
    expect(await count("challenge_secrets")).toBe(0);
  });

  it("suppresses a newer explicit send when an older in-flight delivery proves invalid recipient", async () => {
    const harness = currentRuntime();
    const created = await create("stale-invalid-recipient");
    const challengeId = challengeIdFrom(created);
    const oldJob = await fetchJob();
    const reserved = await harness.run(dispatchGate(harness.configuration, oldJob.data));
    expect(reserved?.providerId).toBe("fake-primary");
    await harness.run(
      harness.pg`UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id::text = ${challengeId}`,
    );
    const next = await Effect.runPromise(
      harness.router.deliver({
        key: "next-while-old-in-flight",
        challengeId,
        requestId: randomUUID(),
        input: { action: "next" },
      }),
    );
    if (!("deliveryId" in next.body)) throw new Error("Expected a delivery result");

    await harness.run(
      recordOutcome(harness.configuration, oldJob.data.deliveryId, {
        state: "failed",
        acceptance: "not_accepted",
        failureCategory: "InvalidRecipient",
        diagnosticCode: "integration_fake_invalid_recipient",
        stop: true,
      }),
    );
    const routing = await query(
      Schema.Struct({ routing_revision: Schema.Int }),
      `SELECT routing_revision FROM otp_router.deliveries WHERE id = '${next.body.deliveryId}'`,
    );
    const routingRevision = routing[0]?.routing_revision;
    if (routingRevision === undefined) throw new Error("Expected the newer routing revision");
    await harness.run(
      dispatch(harness.configuration, {
        version: 1,
        deliveryId: next.body.deliveryId,
        routingRevision,
      }),
    );

    expect(primary.sends).toHaveLength(0);
    expect(secondary.sends).toHaveLength(0);
    expect(
      await query(
        Schema.Struct({
          reason: Schema.String,
          state: Schema.String,
          diagnostic_code: Schema.NullOr(Schema.String),
        }),
        "SELECT reason, state, diagnostic_code FROM otp_router.deliveries ORDER BY route_position",
      ),
    ).toEqual([
      { reason: "initial", state: "failed", diagnostic_code: "integration_fake_invalid_recipient" },
      { reason: "next", state: "suppressed", diagnostic_code: null },
    ]);
    const status = await Effect.runPromise(harness.router.status(challengeId));
    expect(status.body).toMatchObject({
      verificationState: "active",
      actions: {
        resend: { allowed: false, reason: "delivery_unavailable" },
        next: { allowed: false, reason: "delivery_unavailable" },
        select: { allowed: false, reason: "delivery_unavailable" },
        verify: { allowed: true },
      },
    });
    expect(
      await Effect.runPromise(
        Effect.result(
          harness.router.deliver({
            key: "resend-after-stale-invalid-recipient",
            challengeId,
            requestId: randomUUID(),
            input: { action: "resend" },
          }),
        ),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "delivery_unavailable" } });
  });

  it("reuses the code for explicit resend and erases terminal secrets", async () => {
    const harness = currentRuntime();
    const config = withProviderIdempotency(harness.configuration, "fake-primary");
    const created = await createDirect(config, "idempotent-provider-create");
    const challengeId = challengeIdFrom(created);
    const initialDeliveryId = deliveryFromCreated(created);
    await dispatchNext(config);
    const originalCode = primary.sends[0]?.code;
    if (originalCode === undefined) throw new Error("Expected the initial send code");
    expect(primary.sends[0]).toMatchObject({
      deliveryId: initialDeliveryId,
      providerIdempotencyKey: initialDeliveryId,
    });
    expect(primary.sends[0]?.remainingDeliveryMs).toBeGreaterThan(0);
    const wrongCode = originalCode === "999999" ? "999998" : "999999";
    const wrong = await Effect.runPromise(
      harness.router.verify({
        key: "wrong-before-resend",
        challengeId,
        requestId: randomUUID(),
        input: { code: wrongCode, purpose: "login", contextId: "session-1" },
      }),
    );
    expect(wrong.body).toMatchObject({ error: { code: "incorrect_code" } });
    const beforeResend = await query(
      Schema.Struct({ expires_at: Schema.Date, incorrect_guesses: Schema.Int }),
      `SELECT expires_at, incorrect_guesses FROM otp_router.challenges WHERE id = '${challengeId}'`,
    );
    expect(beforeResend[0]?.incorrect_guesses).toBe(1);
    await execute(
      `UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id = '${challengeId}'`,
    );
    const resendRequest = {
      key: "explicit-resend",
      challengeId,
      requestId: randomUUID(),
      input: { action: "resend" as const },
    };
    const resend = await harness.run(requestDelivery(config, resendRequest));
    expect(resend.status).toBe(202);
    if (!("deliveryId" in resend.body)) throw new Error("Expected a delivery result");
    const replayed = await harness.run(
      requestDelivery(config, { ...resendRequest, requestId: randomUUID() }),
    );
    expect(replayed).toMatchObject({ replayed: true, body: resend.body });
    expect(await count("deliveries")).toBe(2);
    expect(primary.sends).toHaveLength(1);
    await dispatchNext(config);
    expect(primary.sends.map((input) => input.code)).toEqual([originalCode, originalCode]);
    expect(primary.sends[1]).toMatchObject({
      deliveryId: resend.body.deliveryId,
      providerIdempotencyKey: resend.body.deliveryId,
    });
    expect(resend.body.deliveryId).not.toBe(initialDeliveryId);
    expect(
      await query(
        Schema.Struct({ expires_at: Schema.Date, incorrect_guesses: Schema.Int }),
        `SELECT expires_at, incorrect_guesses FROM otp_router.challenges WHERE id = '${challengeId}'`,
      ),
    ).toEqual(beforeResend);
    await Effect.runPromise(
      currentRuntime().router.verify({
        key: "verify-after-resend",
        challengeId,
        requestId: randomUUID(),
        input: { code: originalCode, purpose: "login", contextId: "session-1" },
      }),
    );
    expect(await count("challenge_secrets")).toBe(0);
    const fingerprints = await query(
      Schema.Struct({ count: Schema.Int }),
      "SELECT count(*)::integer AS count FROM otp_router.idempotency_records WHERE code_fingerprint IS NOT NULL",
    );
    expect(fingerprints[0]?.count).toBe(0);
  });

  it("keeps verification available after the send budget is exhausted", async () => {
    const harness = currentRuntime();
    const policy = harness.configuration.settings.policies["default"];
    if (policy === undefined) throw new Error("Expected the default policy");
    const config: RuntimeConfiguration = {
      ...harness.configuration,
      settings: {
        ...harness.configuration.settings,
        policies: {
          ...harness.configuration.settings.policies,
          default: { ...policy, maxSends: 1 },
        },
      },
    };
    const created = await createDirect(config, "send-budget-verification");
    const challengeId = challengeIdFrom(created);
    const code = await readCode(challengeId);
    await dispatchNext(config);

    const status = await Effect.runPromise(harness.router.status(challengeId));
    expect(status.body).toMatchObject({
      verificationState: "active",
      actions: {
        resend: { allowed: false, reason: "rate_limited" },
        verify: { allowed: true },
      },
    });
    expect(await count("challenge_secrets")).toBe(1);
    expect(
      await query(
        Schema.Struct({ send_count: Schema.Int }),
        `SELECT send_count FROM otp_router.challenges WHERE id = '${challengeId}'`,
      ),
    ).toEqual([{ send_count: 1 }]);

    const verified = await Effect.runPromise(
      harness.router.verify({
        key: "verify-after-send-budget",
        challengeId,
        requestId: randomUUID(),
        input: { code, purpose: "login", contextId: "session-1" },
      }),
    );
    expect(verified.status).toBe(200);
    expect(await count("challenge_secrets")).toBe(0);
  });

  it("reconciles a delivered callback that arrives before the send response", async () => {
    const created = await create();
    const job = await fetchJob();
    primary.outcome = "blocked-accepted";
    primary.started = Promise.withResolvers<void>();
    primary.release = Promise.withResolvers<void>();
    const providerReference = `fake-primary:${job.data.deliveryId}`;
    const sending = currentRuntime().run(dispatch(currentRuntime().configuration, job.data));
    await primary.started.promise;
    await currentRuntime().run(
      ingestEvents(currentRuntime().configuration, "fake-primary", [
        callbackEvent("early-delivered", providerReference, "delivered"),
      ]),
    );
    expect(
      await query(
        Schema.Struct({ processed: Schema.Boolean }),
        "SELECT processed FROM otp_router.callback_inbox",
      ),
    ).toEqual([{ processed: false }]);
    primary.release.resolve();
    await sending;
    expect(
      await query(
        Schema.Struct({ state: Schema.String, acceptance: Schema.String }),
        `SELECT state, acceptance FROM otp_router.deliveries WHERE id = '${deliveryFromCreated(created)}'`,
      ),
    ).toEqual([{ state: "delivered", acceptance: "accepted" }]);
    expect(
      await query(
        Schema.Struct({ processed: Schema.Boolean }),
        "SELECT processed FROM otp_router.callback_inbox",
      ),
    ).toEqual([{ processed: true }]);
  });

  it("preserves an adapter handshake status, content type, and raw bytes over HTTP", async () => {
    const harness = currentRuntime();
    const provider = harness.configuration.providers.get("fake-primary");
    if (provider === undefined) throw new Error("Missing fake provider");
    const bytes = new Uint8Array([0, 255, 128, 65]);
    const configuration = {
      ...harness.configuration,
      providers: new Map([
        [
          provider.instanceId,
          {
            ...provider,
            callback: () =>
              Effect.succeed({
                _tag: "Handshake" as const,
                status: 202,
                contentType: "application/octet-stream",
                body: bytes,
              }),
          },
        ],
      ]),
    };
    const webhooks = await harness.run(
      WebhookHandler.pipe(
        Effect.provide(WebhooksLive),
        Effect.provideService(RouterConfig, configuration),
        Effect.scoped,
      ),
    );
    const server = makeWebHandler({ apiKeys: [apiKey] }, { router: harness.router, webhooks });
    try {
      const response = await server.handler(
        new Request("http://router.test/webhooks/fake-primary"),
      );
      expect(response.status).toBe(202);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await server.dispose();
    }
  });

  it("persists allowlisted callback diagnostics and redacts arbitrary provider text", async () => {
    await create();
    const job = await dispatchNext();
    const config = currentRuntime().configuration;
    await currentRuntime().run(
      ingestEvents(config, "fake-primary", [
        {
          ...callbackEvent("diagnostic", `fake-primary:${job.deliveryId}`, "failed"),
          diagnosticCode: "callback_failed",
        },
      ]),
    );
    expect(
      await query(
        Schema.Struct({ diagnostic_code: Schema.String }),
        `SELECT diagnostic_code FROM otp_router.deliveries WHERE id = '${job.deliveryId}'`,
      ),
    ).toEqual([{ diagnostic_code: "callback_failed" }]);
    await currentRuntime().run(
      ingestEvents(config, "fake-primary", [
        {
          ...callbackEvent("unsafe-diagnostic", "orphan", "failed"),
          diagnosticCode: "secret payload 123456",
        },
      ]),
    );
    expect(
      await query(
        Schema.Struct({ diagnostic_code: Schema.String }),
        "SELECT diagnostic_code FROM otp_router.callback_inbox WHERE deduplication_key = 'unsafe-diagnostic'",
      ),
    ).toEqual([{ diagnostic_code: "unclassified" }]);
  });

  it("deduplicates delivered callbacks without suppressing a later explicit resend", async () => {
    const created = await create();
    const challengeId = challengeIdFrom(created);
    const initialDeliveryId = deliveryFromCreated(created);
    await dispatchNext();
    await execute(
      `UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id = '${challengeId}'`,
    );
    await Effect.runPromise(
      currentRuntime().router.deliver({
        key: "resend-before-callback",
        challengeId,
        requestId: randomUUID(),
        input: { action: "resend" },
      }),
    );
    const event = callbackEvent(
      "duplicate-delivered",
      `fake-primary:${initialDeliveryId}`,
      "delivered",
    );
    await currentRuntime().run(
      ingestEvents(currentRuntime().configuration, "fake-primary", [event]),
    );
    await currentRuntime().run(
      ingestEvents(currentRuntime().configuration, "fake-primary", [event]),
    );
    expect(
      await query(
        Schema.Struct({ reason: Schema.String, state: Schema.String }),
        "SELECT reason, state FROM otp_router.deliveries ORDER BY reason",
      ),
    ).toEqual([
      { reason: "initial", state: "delivered" },
      { reason: "resend", state: "pending" },
    ]);
    expect(await count("callback_inbox")).toBe(1);
  });

  it("does not let a stale failure callback advance past a newer next action", async () => {
    const created = await create();
    const challengeId = challengeIdFrom(created);
    const initialDeliveryId = deliveryFromCreated(created);
    await dispatchNext();
    await execute(
      `UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id = '${challengeId}'`,
    );
    await Effect.runPromise(
      currentRuntime().router.deliver({
        key: "next-before-stale-failure",
        challengeId,
        requestId: randomUUID(),
        input: { action: "next" },
      }),
    );
    await currentRuntime().run(
      ingestEvents(currentRuntime().configuration, "fake-primary", [
        callbackEvent("stale-failure", `fake-primary:${initialDeliveryId}`, "failed"),
      ]),
    );
    expect(
      await query(
        Schema.Struct({
          provider_instance_id: Schema.String,
          reason: Schema.String,
          state: Schema.String,
        }),
        "SELECT provider_instance_id, reason, state FROM otp_router.deliveries ORDER BY route_position",
      ),
    ).toEqual([
      { provider_instance_id: "fake-primary", reason: "initial", state: "failed" },
      { provider_instance_id: "fake-secondary", reason: "next", state: "pending" },
    ]);
  });

  it("atomically reserves the last deployment send across different recipients", async () => {
    const left = await create("deployment-cap-left", "+998901234567");
    const right = await create("deployment-cap-right", "+998909876543");
    const limited = withSettings({ deploymentSendLimit15m: 1 });
    const jobs: readonly DeliveryJobType[] = [
      { version: 1, deliveryId: deliveryFromCreated(left), routingRevision: 1 },
      { version: 1, deliveryId: deliveryFromCreated(right), routingRevision: 1 },
    ];
    await Promise.all(jobs.map((job) => currentRuntime().run(dispatch(limited, job))));
    expect(primary.sends).toHaveLength(1);
    expect(
      await query(
        Schema.Struct({ state: Schema.String, count: Schema.Int }),
        "SELECT state, count(*)::integer AS count FROM otp_router.deliveries GROUP BY state ORDER BY state",
      ),
    ).toEqual([
      { state: "accepted", count: 1 },
      { state: "suppressed", count: 1 },
    ]);
    expect(
      await query(
        Counts,
        "SELECT count(*)::integer AS count FROM otp_router.quota_events WHERE identity = 'deployment' AND kind = 'send'",
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("selects an available same-channel provider while preserving explicit provider quotas", async () => {
    const harness = currentRuntime();
    const providers = new Map(harness.configuration.providers);
    const first = providers.get("fake-primary");
    if (first === undefined) throw new Error("Expected the primary provider");
    providers.set("fake-primary", { ...first, channel: "sms" });
    const config: RuntimeConfiguration = {
      ...withSettings({
        providerSendLimits15m: { "fake-primary": 1, "fake-secondary": 1 },
      }),
      providers,
    };
    await harness.run(
      harness.pg`INSERT INTO otp_router.quota_keys(identity) VALUES ('provider:fake-primary')`,
    );
    await harness.run(
      harness.pg`INSERT INTO otp_router.quota_events(identity,kind,event_id,occurred_at) VALUES ('provider:fake-primary','send',${randomUUID()},clock_timestamp())`,
    );
    const created = await createDirect(config, "same-channel-create", {
      ...createInput(),
      deliveryChoice: { type: "channel", channel: "sms" },
    });
    const challengeId = challengeIdFrom(created);
    expect(
      await query(
        Schema.Struct({ provider_instance_id: Schema.String }),
        `SELECT provider_instance_id FROM otp_router.deliveries WHERE id = '${deliveryFromCreated(created)}'`,
      ),
    ).toEqual([{ provider_instance_id: "fake-secondary" }]);

    expect(
      await harness.run(
        Effect.result(
          createChallenge(config, {
            key: "same-channel-explicit-create",
            input: {
              ...createInput(),
              contextId: "explicit-primary-create",
              deliveryChoice: { type: "provider", providerInstanceId: "fake-primary" },
            },
            requestId: randomUUID(),
          }),
        ),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "rate_limited" } });
    expect(await count("challenges")).toBe(1);

    await harness.run(
      harness.pg`UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id::text = ${challengeId}`,
    );

    const selected = await harness.run(
      requestDelivery(config, {
        key: "same-channel-generic",
        challengeId,
        requestId: randomUUID(),
        input: { action: "select", choice: { type: "channel", channel: "sms" } },
      }),
    );
    if (!("deliveryId" in selected.body)) throw new Error("Expected a delivery result");
    expect(
      await query(
        Schema.Struct({ provider_instance_id: Schema.String }),
        `SELECT provider_instance_id FROM otp_router.deliveries WHERE id = '${selected.body.deliveryId}'`,
      ),
    ).toEqual([{ provider_instance_id: "fake-secondary" }]);

    await harness.run(
      harness.pg`UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id::text = ${challengeId}`,
    );
    expect(
      await harness.run(
        Effect.result(
          requestDelivery(config, {
            key: "same-channel-explicit-primary",
            challengeId,
            requestId: randomUUID(),
            input: {
              action: "select",
              choice: { type: "provider", providerInstanceId: "fake-primary" },
            },
          }),
        ),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "rate_limited" } });
  });

  it("blocks a correct code at the recipient guess cap without extending usage", async () => {
    const first = await create("guess-cap-first");
    const second = await create("guess-cap-second");
    const firstId = challengeIdFrom(first);
    const secondId = challengeIdFrom(second);
    const secondCode = await readCode(secondId);
    const limited = withSettings({ recipientGuessLimit15m: 1 });
    await currentRuntime().run(
      verifyChallenge(limited, {
        key: "guess-cap-consume",
        challengeId: firstId,
        requestId: randomUUID(),
        input: { code: "999999", purpose: "login", contextId: "session-1" },
      }),
    );
    const attemptCorrect = (operationKey: string) =>
      currentRuntime().run(
        Effect.result(
          verifyChallenge(limited, {
            key: operationKey,
            challengeId: secondId,
            requestId: randomUUID(),
            input: { code: secondCode, purpose: "login", contextId: "session-1" },
          }),
        ),
      );
    expect(await attemptCorrect("guess-cap-blocked-a")).toMatchObject({
      _tag: "Failure",
      failure: { code: "rate_limited" },
    });
    expect(await attemptCorrect("guess-cap-blocked-b")).toMatchObject({
      _tag: "Failure",
      failure: { code: "rate_limited" },
    });
    expect(
      await query(
        Counts,
        "SELECT count(*)::integer AS count FROM otp_router.quota_events WHERE kind = 'guess'",
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await query(
        Schema.Struct({ verification_state: Schema.String, incorrect_guesses: Schema.Int }),
        `SELECT verification_state, incorrect_guesses FROM otp_router.challenges WHERE id = '${secondId}'`,
      ),
    ).toEqual([{ verification_state: "active", incorrect_guesses: 0 }]);
  });

  it("rejects selector timeout, rejection, expansion, and an excluded manual choice", async () => {
    const base = currentRuntime().configuration;
    const runFailure = async (
      operationKey: string,
      selector: RuntimeConfiguration["selectors"][string],
      expectedCode: string,
      input: CreateInput = createInput(),
    ): Promise<void> => {
      const selected: RuntimeConfiguration = {
        ...base,
        settings: { ...base.settings, selectorTimeoutMs: 5 },
        selectors: { default: selector },
      };
      const result = await currentRuntime().run(
        Effect.result(
          createChallenge(selected, {
            key: operationKey,
            input,
            requestId: randomUUID(),
          }),
        ),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: expectedCode } });
      expect(await count("challenges")).toBe(0);
    };
    await runFailure("selector-timeout", () => Effect.never, "temporarily_unavailable");
    await runFailure(
      "selector-reject",
      () => Effect.succeed({ _tag: "Reject" }),
      "delivery_unavailable",
    );
    await runFailure(
      "selector-expansion",
      () => Effect.succeed({ _tag: "Route", providerInstanceIds: ["not-permitted"] }),
      "temporarily_unavailable",
    );
    await runFailure(
      "selector-manual-excluded",
      () => Effect.succeed({ _tag: "Route", providerInstanceIds: ["fake-primary"] }),
      "delivery_option_not_allowed",
      {
        ...createInput(),
        deliveryChoice: { type: "provider", providerInstanceId: "fake-secondary" },
      },
    );
  });

  it("persists per-provider locale templates and reuses them without rerunning selection", async () => {
    const base = currentRuntime().configuration;
    const originalPrimary = base.providers.get("fake-primary");
    const originalSecondary = base.providers.get("fake-secondary");
    if (originalPrimary === undefined || originalSecondary === undefined)
      throw new Error("Expected both integration providers");
    const seenPrimary: string[][] = [];
    const seenSecondary: string[][] = [];
    const localizedPrimary: ReadyProvider = {
      ...originalPrimary,
      resolveTemplate: (candidates) => {
        seenPrimary.push([...candidates]);
        return Effect.succeed({ locale: "ru", template: { provider: "primary", language: "ru" } });
      },
    };
    const localizedSecondary: ReadyProvider = {
      ...originalSecondary,
      resolveTemplate: (candidates) => {
        seenSecondary.push([...candidates]);
        return Effect.succeed({
          locale: "en",
          template: { provider: "secondary", language: "en" },
        });
      },
    };
    const providers = new Map(base.providers);
    providers.set("fake-primary", localizedPrimary);
    providers.set("fake-secondary", localizedSecondary);
    let selectorRuns = 0;
    const config: RuntimeConfiguration = {
      ...base,
      providers,
      selectors: {
        default: () =>
          Effect.sync(() => {
            selectorRuns += 1;
            return {
              _tag: "Route" as const,
              providerInstanceIds: ["fake-primary", "fake-secondary"],
            };
          }),
      },
      settings: {
        ...base.settings,
        defaultLocale: "en",
        fallbackLocales: ["ru", "en", "ru", "en"],
      },
    };
    const created = await createDirect(config, "locale-fallback", {
      ...createInput(),
      locale: "uz",
    });
    const challengeId = challengeIdFrom(created);
    expect(seenPrimary).toEqual([["uz", "ru", "en"]]);
    expect(seenSecondary).toEqual([["uz", "ru", "en"]]);
    expect(selectorRuns).toBe(1);
    expect(
      await query(
        Schema.Struct({
          primary_locale: Schema.String,
          primary_template: Schema.Unknown,
          secondary_locale: Schema.String,
          secondary_template: Schema.Unknown,
        }),
        "SELECT snapshot->'providers'->0->>'resolvedLocale' AS primary_locale, snapshot->'providers'->0->'template' AS primary_template, snapshot->'providers'->1->>'resolvedLocale' AS secondary_locale, snapshot->'providers'->1->'template' AS secondary_template FROM otp_router.challenges",
      ),
    ).toEqual([
      {
        primary_locale: "ru",
        primary_template: { provider: "primary", language: "ru" },
        secondary_locale: "en",
        secondary_template: { provider: "secondary", language: "en" },
      },
    ]);

    await dispatchNext(config);
    await currentRuntime().run(
      currentRuntime()
        .pg`UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id::text = ${challengeId}`,
    );
    await currentRuntime().run(
      requestDelivery(config, {
        key: "locale-snapshot-resend",
        challengeId,
        requestId: randomUUID(),
        input: { action: "resend" },
      }),
    );
    await dispatchNext(config);
    expect(selectorRuns).toBe(1);
    expect(seenPrimary).toHaveLength(1);
    expect(seenSecondary).toHaveLength(1);
    expect(primary.sends).toHaveLength(2);
    expect(primary.sends.map(({ locale, template }) => ({ locale, template }))).toEqual([
      { locale: "ru", template: { provider: "primary", language: "ru" } },
      { locale: "ru", template: { provider: "primary", language: "ru" } },
    ]);
  });

  it("commits terminal expiry when an explicit delivery request finds an expired challenge", async () => {
    const created = await create();
    const challengeId = challengeIdFrom(created);
    await execute(
      `UPDATE otp_router.challenges SET expires_at = clock_timestamp() - interval '1 second', next_user_send_at = clock_timestamp() - interval '1 second' WHERE id = '${challengeId}'`,
    );
    const result = await Effect.runPromise(
      Effect.result(
        currentRuntime().router.deliver({
          key: "deliver-after-expiry",
          challengeId,
          requestId: randomUUID(),
          input: { action: "resend" },
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "challenge_unavailable" },
    });
    expect(
      await query(
        Schema.Struct({ verification_state: Schema.String }),
        `SELECT verification_state FROM otp_router.challenges WHERE id = '${challengeId}'`,
      ),
    ).toEqual([{ verification_state: "expired" }]);
    expect(
      await query(
        Schema.Struct({ state: Schema.String }),
        "SELECT state FROM otp_router.deliveries",
      ),
    ).toEqual([{ state: "suppressed" }]);
    expect(await count("challenge_secrets")).toBe(0);
  });

  it("commits terminal expiry when cancellation finds an expired challenge", async () => {
    const created = await create();
    const challengeId = challengeIdFrom(created);
    await execute(
      `UPDATE otp_router.challenges SET expires_at = clock_timestamp() - interval '1 second' WHERE id = '${challengeId}'`,
    );
    const result = await Effect.runPromise(
      Effect.result(
        currentRuntime().router.cancel({
          key: "cancel-after-expiry",
          challengeId,
          requestId: randomUUID(),
          input: {},
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "challenge_state_conflict" },
    });
    expect(
      await query(
        Schema.Struct({ verification_state: Schema.String }),
        `SELECT verification_state FROM otp_router.challenges WHERE id = '${challengeId}'`,
      ),
    ).toEqual([{ verification_state: "expired" }]);
    expect(
      await query(
        Schema.Struct({ state: Schema.String }),
        "SELECT state FROM otp_router.deliveries",
      ),
    ).toEqual([{ state: "suppressed" }]);
    expect(await count("challenge_secrets")).toBe(0);
  });

  it("samples database time after a blocked row lock before deciding expiry", async () => {
    const created = await create();
    const challengeId = challengeIdFrom(created);
    const code = await readCode(challengeId);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const harness = currentRuntime();
    const holder = harness.run(
      harness.pg.withTransaction(
        harness.pg
          .unsafe("SELECT id FROM otp_router.challenges WHERE id = $1 FOR UPDATE", [challengeId])
          .pipe(
            Effect.tap(() => Effect.sync(() => locked.resolve())),
            Effect.andThen(Effect.promise(() => release.promise)),
            Effect.andThen(
              harness.pg.unsafe(
                "UPDATE otp_router.challenges SET expires_at = clock_timestamp() WHERE id = $1",
                [challengeId],
              ),
            ),
          ),
      ),
    );
    await locked.promise;
    const verification = Effect.runPromise(
      Effect.result(
        harness.router.verify({
          key: "verify-after-lock-expiry",
          challengeId,
          requestId: randomUUID(),
          input: { code, purpose: "login", contextId: "session-1" },
        }),
      ),
    );
    try {
      await waitForChallengeRowWaiter();
    } finally {
      release.resolve();
    }
    await holder;
    expect(await verification).toMatchObject({
      _tag: "Failure",
      failure: { code: "challenge_unavailable" },
    });
    expect(
      await query(
        Schema.Struct({ verification_state: Schema.String }),
        `SELECT verification_state FROM otp_router.challenges WHERE id = '${challengeId}'`,
      ),
    ).toEqual([{ verification_state: "expired" }]);
    expect(await count("challenge_secrets")).toBe(0);
  });
});
