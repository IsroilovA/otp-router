import { Projects } from "@otp-router/engine/projects";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Exit, Layer, Redacted, Schema, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createClient, type OtpRouterClient } from "@otp-router/client";
import { Router } from "@otp-router/engine/challenges";
import { Delivery, DeliveryHistory } from "@otp-router/engine/delivery";
import {
  FakeProvider,
  ProviderInstance,
  ProviderInstanceIdSchema,
  type ProviderSendInput,
} from "@otp-router/engine/providers";
import { makeHttpApiLayer } from "../apps/server/src/http/transport.js";
import { WebhookError, WebhookHandler } from "../apps/server/src/http/webhooks.js";
import { dispatch } from "../packages/engine/src/delivery/dispatch.js";
import { deliveryQueue, DeliveryJob } from "../packages/engine/src/queue/contracts.js";
import {
  startPostgres,
  startRuntime,
  type PostgresFixture,
  type IntegrationRuntime,
} from "./fixture.js";

const ring = (byte: number) => ({
  active: "v1",
  keys: { v1: Buffer.alloc(32, byte).toString("base64url") },
});
const bearerToken = "client-integration-key-with-at-least-32-bytes";
const sent: ProviderSendInput[] = [];
const provider = Layer.effect(
  ProviderInstance,
  Effect.gen(function* () {
    const base = yield* ProviderInstance;
    return {
      ...base,
      send: (input: ProviderSendInput) => {
        sent.push(input);
        return base.send(input);
      },
    };
  }),
).pipe(
  Layer.provide(
    FakeProvider.make({
      instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)("fake"),
      enabled: true,
      compatibilityRevision: "client-test",
      config: { outcome: "accepted", callbackSecret: Redacted.make("callback-secret") },
      templates: {},
    }),
  ),
);
let postgres: PostgresFixture | undefined;
let runtime: IntegrationRuntime | undefined;
let scope: Scope.Scope | undefined;
let client: OtpRouterClient | undefined;
let baseUrl = "";

beforeAll(async () => {
  postgres = await startPostgres();
  runtime = await startRuntime(postgres.databaseUrl, {
    settings: {
      crypto: {
        deploymentId: "client-tests",
        encryption: ring(1),
        verification: ring(2),
        fingerprint: ring(3),
        recipientKey: Buffer.alloc(32, 4).toString("base64url"),
      },
      defaultLocale: "en",
      fallbackLocales: [],
      policies: { login: { managed: {}, providerInstanceIds: ["fake"] } },
      purposes: { login: ["login"] },
      administration: {
        principalIds: ["backend"],
        administrators: {
          admin: {
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
    providers: [provider],
  });
  scope = await Effect.runPromise(Scope.make());
  const server = createServer();
  const api = makeHttpApiLayer({
    administrators: [{ id: "admin", keys: ["admin-test-credential-with-at-least-32-bytes"] }],
    principals: [{ id: "backend", keys: [bearerToken] }],
  }).pipe(
    HttpRouter.provideRequest(
      Layer.mergeAll(
        Layer.succeed(Projects, runtime.projects),
        Layer.succeed(Router, runtime.router),
        Layer.succeed(Delivery, runtime.delivery),
        Layer.succeed(DeliveryHistory, runtime.history),
        Layer.succeed(WebhookHandler, {
          handshake: () => Effect.fail(new WebhookError({ code: "unknown_instance" })),
          ingest: () => Effect.fail(new WebhookError({ code: "unknown_instance" })),
        }),
      ),
    ),
  );
  await Effect.runPromise(
    Layer.build(
      HttpRouter.serve(api, { disableLogger: true }).pipe(
        Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port: 0 })),
      ),
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Server did not bind TCP");
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  client = createClient({ baseUrl, bearerToken, projectId: "demo" });
}, 30_000);

afterAll(async () => {
  if (scope !== undefined) await Effect.runPromise(Scope.close(scope, Exit.void));
  await runtime?.close();
  await postgres?.close();
}, 15_000);

it("integrates managed verification, external delivery, replay, auth and history through real HTTP", async () => {
  if (client === undefined || runtime === undefined) throw new Error("Missing test runtime");
  const input = {
    recipient: { type: "phone" as const, phoneNumber: "+998901234567" },
    purpose: "login",
    policyId: "login",
    contextId: "managed-flow",
  };
  const key = randomUUID();
  const created = await client.createChallenge(input, { idempotencyKey: key });
  const replayed = await client.createChallenge(input, { idempotencyKey: key });
  expect(created).toMatchObject({ status: 201, replayed: false, data: { state: "queued" } });
  expect(replayed).toMatchObject({ status: 201, replayed: true, data: created.data });
  const jobs = await runtime.queue.fetch(deliveryQueue, { batchSize: 10 });
  for (const job of jobs) {
    await runtime.run(
      dispatch(runtime.configuration, Schema.decodeUnknownSync(DeliveryJob)(job.data)),
    );
    await runtime.queue.complete(deliveryQueue, job.id);
  }
  expect(sent).toHaveLength(1);
  const received = sent[0];
  if (received === undefined) throw new Error("Provider did not receive managed code");
  const challengeId = created.data.challengeId;
  const status = await client.getChallenge(challengeId);
  expect(status.data.state).toBe("accepted");
  const verified = await client.verifyChallenge(
    challengeId,
    { purpose: "login", contextId: "managed-flow", code: received.code },
    { idempotencyKey: randomUUID() },
  );
  expect(verified.data).toMatchObject({ challengeId, contextId: "managed-flow", purpose: "login" });
  const prepared = await client.prepareDelivery(
    {
      ...input,
      recipient: { type: "phone", phoneNumber: "+998901234568" },
      contextId: "external-flow",
      expiresAt: new Date(Date.now() + 240000).toISOString(),
    },
    { idempotencyKey: randomUUID() },
  );
  const operationId = prepared.data.operationId;
  expect(prepared.data.state).toBe("prepared");
  const submitted = await client.submitDeliveryCode(
    operationId,
    { code: "000123" },
    { idempotencyKey: randomUUID() },
  );
  expect(submitted.data.state).toBe("queued");
  expect(
    (await client.closeDelivery(operationId, { idempotencyKey: randomUUID() })).data.state,
  ).toBe("closed");
  expect((await client.getDelivery(operationId)).data.state).toBe("closed");
  const operations = await client.listOperations({ limit: 1 });
  expect(operations.data.operations).toHaveLength(1);
  expect(operations.data.nextCursor).toEqual(expect.any(String));
  const attempts = await client.listAttempts(created.data.operationId);
  const attempt = attempts.data.attempts[0];
  if (attempt === undefined) throw new Error("Missing retained attempt");
  expect((await client.getAttempt(attempt.attemptId)).data).toEqual(attempt);
  const events = await client.listEvents({ operationId: created.data.operationId });
  expect(
    events.data.events.some(
      (event) => event.type === "challenge.updated" && event.challenge.state === "verified",
    ),
  ).toBe(true);
  const unauthorized = createClient({
    baseUrl,
    projectId: "demo",
    bearerToken: "wrong-credential",
  });
  await expect(unauthorized.getChallenge(challengeId)).rejects.toMatchObject({
    code: "unauthorized",
    status: 401,
  });
  await expect(
    client.createChallenge({ ...input, contextId: "changed" }, { idempotencyKey: key }),
  ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
});

it("admin client preserves revision headers, lost-response replay and credential separation", async () => {
  const { createAdminClient, OtpRouterApiError } = await import("@otp-router/client");
  const adminToken = "admin-test-credential-with-at-least-32-bytes";
  let loseResponse = true;
  const administrator = createAdminClient({
    baseUrl,
    bearerToken: adminToken,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (loseResponse && response.status === 201) {
        loseResponse = false;
        await response.arrayBuffer();
        throw new Error("Simulated lost response after commit");
      }
      return response;
    },
  });
  const input = {
    id: "demo_http",
    settings: { authorizationRequired: false, sendLimit15m: 10, sendLimit24h: 100 },
    principalIds: ["backend"],
  };
  const key = randomUUID();
  await expect(administrator.createProject(input, { idempotencyKey: key })).rejects.toMatchObject({
    kind: "transport",
  });
  const created = await administrator.createProject(input, { idempotencyKey: key });
  expect(created).toMatchObject({
    status: 201,
    replayed: true,
    etag: '"1"',
    data: { id: "demo_http", revision: 1 },
  });
  const suspensionKey = randomUUID();
  const suspended = await administrator.suspendProject(input.id, {
    idempotencyKey: suspensionKey,
    etag: '"1"',
  });
  expect(suspended.etag).toBe('"2"');
  const replay = await administrator.suspendProject(input.id, {
    idempotencyKey: suspensionKey,
    etag: '"1"',
  });
  expect(replay.data).toEqual(suspended.data);
  expect(replay.replayed).toBe(true);
  await expect(
    administrator.reactivateProject(input.id, { idempotencyKey: randomUUID(), etag: '"1"' }),
  ).rejects.toMatchObject({ error: { code: "revision_conflict" }, status: 412 });
  const active = await administrator.reactivateProject(input.id, {
    idempotencyKey: randomUUID(),
    etag: '"2"',
  });
  expect(active.data.revision).toBe(3);
  await expect(
    administrator.updateProject(input.id, input.settings, {
      idempotencyKey: randomUUID(),
      etag: 'W/"3"',
    }),
  ).rejects.toMatchObject({ kind: "invalid_request" });
  const regular = createAdminClient({ baseUrl, bearerToken });
  await expect(regular.getProject(input.id)).rejects.toBeInstanceOf(OtpRouterApiError);
  await expect(regular.getProject(input.id)).rejects.toMatchObject({
    error: { code: "unauthorized" },
  });
  const incorrectClass = createClient({ baseUrl, bearerToken: adminToken, projectId: input.id });
  await expect(incorrectClass.listOperations()).rejects.toMatchObject({
    error: { code: "unauthorized" },
  });
  const page = await administrator.listProjects({ limit: 1 });
  expect(page.data.projects).toHaveLength(1);
  expect(page.data.nextCursor).not.toBeNull();
  const audit = await administrator.listAudit(input.id);
  expect(audit.data.events.map((event) => event.action)).toEqual([
    "create",
    "suspend",
    "reactivate",
  ]);
  const granted = await administrator.revokePrincipal(input.id, "backend", {
    idempotencyKey: randomUUID(),
    etag: '"3"',
  });
  expect(granted.data.grants).toEqual([]);
});
