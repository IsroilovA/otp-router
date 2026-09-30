import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { rows, single } from "../packages/engine/src/database/query.js";
import { ingestEvents, recordAccepted } from "../packages/engine/src/delivery/callbacks.js";
import { dispatchGate } from "../packages/engine/src/delivery/dispatch.js";
import { FakeProvider } from "../packages/engine/src/providers/fake.js";
import {
  ProviderInstanceIdSchema,
  type NormalizedDeliveryEvent,
} from "../packages/engine/src/providers/contract.js";
import { DeliveryJob, deliveryQueue } from "../packages/engine/src/queue/contracts.js";
import {
  ageAdmission,
  startPostgres,
  startRuntime,
  type IntegrationRuntime,
  type PostgresFixture,
} from "./fixture.js";

const ring = (value: number) => ({
  active: "a",
  keys: { a: Buffer.alloc(32, value).toString("base64url") },
});
let database: PostgresFixture | undefined;
let runtime: IntegrationRuntime | undefined;
const app = () => {
  if (runtime === undefined) throw new Error("Runtime missing");
  return runtime;
};
beforeAll(async () => {
  database = await startPostgres();
  runtime = await startRuntime(database.databaseUrl, {
    settings: {
      crypto: {
        deploymentId: "callback-locks",
        encryption: ring(1),
        verification: ring(2),
        fingerprint: ring(3),
        recipientKey: Buffer.alloc(32, 4).toString("base64url"),
      },
      administration: {
        principalIds: ["backend"],
        administrators: {
          admin: {
            runtimeActions: ["read", "manage", "rotate", "policy", "assign", "audit"],
            resourceIds: [],
            resourcePrefixes: [
              "restricted",
              "managed",
              "external",
              "benchmark",
              "fault",
              "fake",
              "primary",
              "secondary",
              "first",
              "second",
              "login",
              "default",
              "demo",
              "process",
              "text",
              "scope",
              "account",
              "telegram",
              "whatsapp",
              "sms",
            ],
            actions: [
              "create",
              "read",
              "list",
              "update",
              "suspend",
              "reactivate",
              "retire",
              "grant",
              "revoke",
              "audit",
            ],
            projectIds: [],
            creationPrefixes: ["demo", "alpha", "beta"],
            grantablePrincipalIds: ["backend"],
            editableSettings: ["authorizationRequired", "sendLimit15m", "sendLimit24h"],
            sendLimit15mCeiling: 1000000,
            sendLimit24hCeiling: 1000000,
            mayDisableAuthorization: true,
          },
        },
        authorizationFloor: false,
      },
      deploymentSendLimit15m: 100,
      deploymentSendLimit24h: 1000,
    },
    fixtures: {
      defaultLocale: "en",
      fallbackLocales: [],
      policies: { login: { providerInstanceIds: ["primary", "secondary"], managed: {} } },
      purposes: { login: ["login"] },
    },
    providerFixtures: ["primary", "secondary"].map((id) =>
      FakeProvider.make({
        instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)(id),
        revision: id,
        identity: { account: "fixture" },
        secrets: {},
        execution: { outcome: "accepted" },
        callbackSecrets: { callbackSecret: "callback-secret" },
        templates: {},
      }),
    ),
  });
}, 30000);
beforeEach(() => app().reset());
afterAll(async () => {
  await runtime?.close();
  await database?.close();
});

const reserve = async () => {
  const harness = app();
  const job = (await harness.queue.fetch<unknown>(deliveryQueue))[0];
  if (job === undefined) throw new Error("Expected delivery job");
  const input = Schema.decodeUnknownSync(DeliveryJob)(job.data);
  expect(await harness.run(dispatchGate(harness.configuration, input))).toBeDefined();
  await harness.queue.complete(deliveryQueue, job.id);
  return input.attemptId;
};

const prepareOperations = async () => {
  const harness = app();
  const challenges = [];
  for (const phoneNumber of ["+998901234567", "+998901234568"]) {
    const created = await Effect.runPromise(
      harness.router.create({
        principalId: "backend",
        projectId: "demo",
        key: randomUUID(),
        requestId: randomUUID(),
        input: {
          recipient: { type: "phone", phoneNumber },
          purpose: "login",
          contextId: "binding",
          policyId: "login",
        },
      }),
    );
    challenges.push({ ...created.body, primary: await reserve() });
  }
  const ordered = challenges.toSorted((left, right) =>
    left.operationId.localeCompare(right.operationId),
  );
  const [first, second] = ordered;
  if (first === undefined || second === undefined) throw new Error("Expected two operations");
  const attempts = [];
  for (const [index, challenge] of ordered.entries()) {
    await harness.run(
      recordAccepted(harness.configuration, challenge.primary, {
        providerRequestId: index === 0 ? "a" : "z",
      }),
    );
    await ageAdmission(harness);
    await harness.run(
      harness.pg`UPDATE otp_router.delivery_operations SET next_user_send_at = clock_timestamp() WHERE id = ${challenge.operationId}`,
    );
    await Effect.runPromise(
      harness.router.deliver({
        principalId: "backend",
        projectId: "demo",
        key: randomUUID(),
        requestId: randomUUID(),
        challengeId: challenge.challengeId,
        input: { action: "next" },
      }),
    );
    const secondary = await reserve();
    await harness.run(
      recordAccepted(harness.configuration, secondary, {
        providerRequestId: index === 0 ? "z" : "a",
      }),
    );
    attempts.push(secondary);
  }
  const secondAttempt = attempts[1];
  if (secondAttempt === undefined) throw new Error("Expected secondary attempt");
  return { firstOperation: first.operationId, secondAttempt };
};

const event = (providerRequestId: string): NormalizedDeliveryEvent => ({
  deduplicationKey: `delivered-${providerRequestId}`,
  correlationReference: { _tag: "ProviderRequest", providerRequestId },
  status: "delivered",
});

const waitForLock = (name: string) => {
  const harness = app();
  return harness.run(
    single(
      Schema.Struct({ waiting: Schema.Boolean }),
      harness.pg`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = ${name} AND wait_event_type = 'Lock') AS waiting`,
    ).pipe(Effect.repeat({ until: (result) => result.waiting }), Effect.timeout("3 seconds")),
  );
};

it.each(["callback batch", "send response"] as const)(
  "serializes overlapping operations from different provider instances: %s",
  async (source) => {
    const harness = app();
    const { firstOperation, secondAttempt } = await prepareOperations();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = harness.run(
      harness.pg.withTransaction(
        Effect.gen(function* () {
          yield* harness.pg`SELECT id FROM otp_router.delivery_operations WHERE id = ${firstOperation} FOR UPDATE`;
          yield* Effect.sync(() => entered.resolve());
          yield* Effect.promise(() => release.promise);
        }),
      ),
    );
    await entered.promise;
    const primary = harness.run(
      harness.pg
        .withTransaction(
          Effect.gen(function* () {
            yield* harness.pg`SELECT set_config('application_name','primary-callback',true)`;
            yield* ingestEvents(harness.configuration, "primary", [event("a"), event("z")]);
          }),
        )
        .pipe(Effect.exit),
    );
    let secondary: typeof primary | undefined;
    try {
      // Queue primary on the lowest operation first. The old implementation then
      // held the higher operation in secondary while waiting behind primary.
      await waitForLock("primary-callback");
      secondary = harness.run(
        harness.pg
          .withTransaction(
            Effect.gen(function* () {
              yield* harness.pg`SELECT set_config('application_name','secondary-callback',true)`;
              if (source === "callback batch")
                yield* ingestEvents(harness.configuration, "secondary", [event("a"), event("z")]);
              else
                yield* recordAccepted(harness.configuration, secondAttempt, {
                  providerRequestId: "a",
                  deliveryEvent: event("z"),
                });
            }),
          )
          .pipe(Effect.exit),
      );
      await waitForLock("secondary-callback");
    } finally {
      release.resolve();
      await blocker;
      const results = await Promise.all([primary, secondary]);
      expect(results.map((result) => result?._tag)).toEqual(["Success", "Success"]);
    }
    const inbox = await harness.run(
      rows(
        Schema.Struct({ processed: Schema.Boolean }),
        harness.pg`SELECT processed FROM otp_router.callback_inbox`,
      ),
    );
    expect(inbox).toEqual(
      Array.from({ length: source === "callback batch" ? 4 : 3 }, () => ({ processed: true })),
    );
    const attempts = await harness.run(
      rows(
        Schema.Struct({ state: Schema.String }),
        harness.pg`SELECT state FROM otp_router.delivery_attempts ORDER BY state`,
      ),
    );
    expect(attempts.map((attempt) => attempt.state)).toEqual(
      source === "callback batch"
        ? ["delivered", "delivered", "delivered", "delivered"]
        : ["accepted", "delivered", "delivered", "delivered"],
    );
  },
);
