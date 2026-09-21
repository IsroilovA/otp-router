import { cleanup } from "../packages/engine/src/maintenance.js";
import { makeWebHandler } from "../apps/server/src/http/transport.js";
import { WebhookError } from "../apps/server/src/http/webhooks.js";
import { randomUUID } from "node:crypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeProvider,
  ProviderInstance,
  ProviderInstanceIdSchema,
  type ProviderSendInput,
} from "../packages/engine/src/providers/index.js";
import type { Configuration } from "../packages/engine/src/config/config.js";
import { rows, single } from "../packages/engine/src/database/query.js";
import { dispatch, dispatchGate } from "../packages/engine/src/delivery/dispatch.js";
import { DeliveryJob, deliveryQueue } from "../packages/engine/src/queue/jobs.js";
import { DeliveryEvent } from "../packages/engine/src/delivery/contracts.js";
import { validateStoredKeys } from "../packages/engine/src/database/compatibility.js";
import {
  startPostgres,
  startRuntime,
  type IntegrationRuntime,
  type PostgresFixture,
} from "./fixture.js";
const ring = (n: number) => ({
  active: "a",
  keys: { a: Buffer.alloc(32, n).toString("base64url") },
});
const sent: ProviderSendInput[] = [];
const provider = Layer.effect(
  ProviderInstance,
  Effect.gen(function* () {
    const base = yield* ProviderInstance;
    return {
      ...base,
      constraints: { ...base.constraints, maxCodeLength: 6 },
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
      settingsFingerprint: "external-tests",
      config: { outcome: "accepted", callbackSecret: Redacted.make("fake-callback") },
      templates: {},
    }),
  ),
);
const configuration: Configuration = {
  settings: {
    crypto: {
      deploymentId: "external-tests",
      encryption: ring(1),
      fingerprint: ring(3),
      recipientKey: Buffer.alloc(32, 4).toString("base64url"),
    },
    defaultLocale: "en",
    fallbackLocales: [],
    policies: {
      external: {
        providerInstanceIds: ["fake"],
        maxLifetimeSeconds: 900,
        manualSelectionEnabled: true,
      },
    },
    purposes: { login: ["external"] },
    deploymentSendLimit15m: 10,
    deploymentSendLimit24h: 20,
  },
  providers: [provider],
};
let database: PostgresFixture | undefined;
let runtime: IntegrationRuntime | undefined;
const app = () => {
  if (runtime === undefined) throw new Error("Runtime missing");
  return runtime;
};
const request = <A>(input: A) => ({ key: randomUUID(), requestId: randomUUID(), input });
const prepare = () =>
  Effect.runPromise(
    app().delivery.prepare(
      request({
        recipient: { type: "phone", phoneNumber: "+998901234567" },
        purpose: "login",
        contextId: "external-flow",
        policyId: "external",
        expiresAt: new Date(Date.now() + 890000).toISOString(),
      }),
    ),
  );
const submit = (operationId: string, code = "123456") => ({ ...request({ code }), operationId });
const close = (operationId: string) =>
  Effect.runPromise(app().delivery.close({ ...request({}), operationId }));
const counts = () =>
  app().run(
    single(
      Schema.Struct({
        attempts: Schema.Int,
        secrets: Schema.Int,
        fingerprints: Schema.Int,
        sends: Schema.Int,
      }),
      app()
        .pg`SELECT (SELECT count(*)::int FROM otp_router.delivery_attempts) AS attempts,(SELECT count(*)::int FROM otp_router.delivery_secrets) AS secrets,(SELECT count(*)::int FROM otp_router.delivery_idempotency WHERE code_fingerprint IS NOT NULL) AS fingerprints,(SELECT count(*)::int FROM otp_router.quota_events WHERE identity='deployment' AND kind='send') AS sends`,
    ),
  );
const runQueued = async () => {
  const jobs = await app().queue.fetch(deliveryQueue, { batchSize: 10 });
  for (const job of jobs) {
    await app().run(dispatch(app().configuration, Schema.decodeUnknownSync(DeliveryJob)(job.data)));
    await app().queue.complete(deliveryQueue, job.id);
  }
};
beforeAll(async () => {
  database = await startPostgres();
  runtime = await startRuntime(database.databaseUrl, configuration);
}, 30000);
afterAll(async () => {
  await runtime?.close();
  await database?.close();
}, 15000);
beforeEach(async () => {
  await app().reset();
  sent.length = 0;
});
describe("independent durable external code delivery", () => {
  it("runs without verification keys and admits a fixed fifteen-minute deadline", async () => {
    const prepared = await prepare();
    expect(prepared.body.state).toBe("prepared");
    expect(prepared.body.actions).not.toHaveProperty("verify");
    expect(prepared.body.actions).toMatchObject({
      resend: { allowed: false, reason: "code_required" },
      next: { allowed: false, reason: "code_required" },
      select: { allowed: false, reason: "code_required", choices: [] },
    });
    expect(await counts()).toMatchObject({ attempts: 0, sends: 0 });
    await app().run(validateStoredKeys(app().configuration.settings));
    const attached = await Effect.runPromise(
      app().delivery.submitCode(submit(prepared.body.operationId)),
    );
    expect(attached.body.expiresAt).toBe(prepared.body.expiresAt);
    await runQueued();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      operationId: prepared.body.operationId,
      code: "123456",
      expiresAt: prepared.body.expiresAt,
    });
    const events = await app().run(
      rows(
        Schema.Struct({ body: Schema.String }),
        app().pg`SELECT body FROM otp_router.events ORDER BY revision`,
      ),
    );
    for (const event of events) {
      const decoded = Schema.decodeUnknownSync(DeliveryEvent)(JSON.parse(event.body));
      expect(decoded.type).toBe("delivery.updated");
      expect(event.body).not.toContain("123456");
      expect(event.body).not.toContain("+998901234567");
    }
  });
  it.each(["close", "expire"] as const)(
    "rejects late code after %s without queuing a provider attempt",
    async (terminal) => {
      const prepared = await prepare(),
        operationId = prepared.body.operationId;
      if (terminal === "close") await close(operationId);
      else
        await app().run(
          app()
            .pg`UPDATE otp_router.delivery_operations SET expires_at=clock_timestamp() WHERE id=${operationId}`,
        );
      const result = await Effect.runPromise(
        app().delivery.submitCode(submit(operationId)).pipe(Effect.result),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "operation_unavailable" } });
      const snapshot = (await Effect.runPromise(app().delivery.status(operationId))).body;
      expect(snapshot).toMatchObject({
        state: terminal === "close" ? "closed" : "expired",
        actions: {
          resend: { allowed: false, reason: "operation_unavailable" },
          next: { allowed: false, reason: "operation_unavailable" },
          select: { allowed: false, reason: "operation_unavailable", choices: [] },
        },
      });
      expect(await counts()).toEqual({ attempts: 0, secrets: 0, fingerprints: 0, sends: 0 });
    },
  );
  it("serializes concurrent duplicate submissions and rejects replacement codes", async () => {
    const prepared = await prepare(),
      operationId = prepared.body.operationId;
    const submission = submit(operationId);
    const results = await Promise.all(
      [submission, submission, submit(operationId)].map((value) =>
        Effect.runPromise(app().delivery.submitCode(value)),
      ),
    );
    expect(results.filter((value) => value.replayed)).toHaveLength(1);
    expect(await counts()).toMatchObject({ attempts: 1, sends: 0 });
    expect(
      await Effect.runPromise(
        app().delivery.submitCode(submit(operationId, "654321")).pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "operation_state_conflict" } });
    await runQueued();
    expect(sent).toHaveLength(1);
    await close(operationId);
    expect(await counts()).toMatchObject({ secrets: 0, fingerprints: 0, sends: 1 });
    // After terminal erasure replay remains a receipt, even when its code differs.
    const replay = await Effect.runPromise(
      app().delivery.submitCode({ ...submission, input: { code: "999999" } }),
    );
    expect(replay.replayed).toBe(true);
    await runQueued();
    expect(sent).toHaveLength(1);
  });
  it("serializes code submission against closure and suppresses pending work", async () => {
    const prepared = await prepare(),
      operationId = prepared.body.operationId;
    await Promise.all([
      Effect.runPromise(app().delivery.submitCode(submit(operationId)).pipe(Effect.result)),
      close(operationId),
    ]);
    await runQueued();
    expect(sent).toHaveLength(0);
    expect((await Effect.runPromise(app().delivery.status(operationId))).body.state).toBe("closed");
    expect(await counts()).toMatchObject({ secrets: 0, fingerprints: 0, sends: 0 });
  });
  it("checks expiry again at dispatch and preserves the original code on explicit resend", async () => {
    const prepared = await prepare(),
      operationId = prepared.body.operationId;
    await Effect.runPromise(app().delivery.submitCode(submit(operationId)));
    await runQueued();
    await app().run(
      app()
        .pg`UPDATE otp_router.delivery_operations SET next_user_send_at=clock_timestamp() WHERE id=${operationId}`,
    );
    await app().run(
      app()
        .pg`UPDATE otp_router.quota_events SET occurred_at=clock_timestamp()-interval '31 seconds' WHERE kind='admission'`,
    );
    await Effect.runPromise(
      app().delivery.deliver({ ...request({ action: "resend" }), operationId }),
    );
    await runQueued();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.code).toBe(sent[1]?.code);
    expect(sent[1]?.expiresAt).toBe(prepared.body.expiresAt);
    await app().run(
      app()
        .pg`UPDATE otp_router.delivery_operations SET expires_at=clock_timestamp() WHERE id=${operationId}`,
    );
    expect(
      await Effect.runPromise(app().delivery.submitCode(submit(operationId)).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "operation_unavailable" } });
    expect(await counts()).toMatchObject({ secrets: 0, fingerprints: 0, sends: 2 });
  });
  it("does not commit a one-step operation when its code cannot be admitted", async () => {
    const result = await Effect.runPromise(
      app()
        .delivery.create(
          request({
            recipient: { type: "phone", phoneNumber: "+998901234567" },
            purpose: "login",
            contextId: "external-flow",
            policyId: "external",
            expiresAt: new Date(Date.now() + 890000).toISOString(),
            code: "12345678",
          }),
        )
        .pipe(Effect.result),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_request" } });
    expect(await counts()).toEqual({ attempts: 0, secrets: 0, fingerprints: 0, sends: 0 });
  });
  it("shares recipient admission and send reservations across external and managed APIs", async () => {
    if (database === undefined) throw new Error("Database missing");
    const h = await startRuntime(database.databaseUrl, {
      ...configuration,
      settings: {
        ...configuration.settings,
        crypto: { ...configuration.settings.crypto, verification: ring(2) },
        recipientSendLimit15m: 1,
        policies: {
          external: { providerInstanceIds: ["fake"], maxLifetimeSeconds: 900 },
          managed: { providerInstanceIds: ["fake"], managed: {} },
        },
        purposes: { login: ["external", "managed"] },
      },
    });
    try {
      const external = await Effect.runPromise(
        h.delivery.create(
          request({
            recipient: { type: "phone", phoneNumber: "+998901234567" },
            purpose: "login",
            contextId: "external",
            policyId: "external",
            expiresAt: new Date(Date.now() + 890000).toISOString(),
            code: "123456",
          }),
        ),
      );
      const managedInput = {
        recipient: { type: "phone" as const, phoneNumber: "+998901234567" },
        purpose: "login",
        contextId: "managed",
        policyId: "managed",
      };
      expect(
        await Effect.runPromise(h.router.create(request(managedInput)).pipe(Effect.result)),
      ).toMatchObject({ _tag: "Failure", failure: { code: "rate_limited" } });
      await h.run(
        h.pg`UPDATE otp_router.quota_events SET occurred_at=clock_timestamp()-interval '31 seconds' WHERE kind='admission'`,
      );
      const managed = await Effect.runPromise(h.router.create(request(managedInput)));
      if (!("operationId" in managed.body)) throw new Error("Managed snapshot missing");
      const operationId = managed.body.operationId;
      for (const effect of [
        h.delivery.close({ ...request({}), operationId }),
        h.delivery.submitCode(submit(operationId)),
        h.delivery.deliver({ ...request({ action: "resend" }), operationId }),
      ])
        expect(await Effect.runPromise(effect.pipe(Effect.result))).toMatchObject({
          _tag: "Failure",
          failure: { code: "managed_operation" },
        });
      const jobs = await h.queue.fetch(deliveryQueue, { batchSize: 10 });
      await Promise.all(
        jobs.map((job) =>
          h.run(dispatch(h.configuration, Schema.decodeUnknownSync(DeliveryJob)(job.data))),
        ),
      );
      expect(sent).toHaveLength(1);
      expect(await counts()).toMatchObject({ sends: 1 });
      expect(
        sent[0]?.operationId === external.body.operationId || sent[0]?.operationId === operationId,
      ).toBe(true);
    } finally {
      await h.close();
    }
  });
  it("does not repeat a committed dispatch after closure or worker recovery", async () => {
    const prepared = await prepare(),
      operationId = prepared.body.operationId;
    await Effect.runPromise(app().delivery.submitCode(submit(operationId)));
    const jobs = await app().queue.fetch(deliveryQueue);
    const job = jobs[0];
    if (job === undefined) throw new Error("Job missing");
    const payload = Schema.decodeUnknownSync(DeliveryJob)(job.data);
    const reserved = await app().run(dispatchGate(app().configuration, payload));
    expect(reserved).toBeDefined();
    await close(operationId);
    await app().run(dispatch(app().configuration, payload));
    expect(sent).toHaveLength(0);
    expect(await counts()).toMatchObject({ sends: 1, secrets: 0, fingerprints: 0 });
  });
  it("authenticates external HTTP endpoints and wires prepare, submit and close", async () => {
    const h = app(),
      apiKey = "external-test-key-with-at-least-thirty-two-bytes";
    const web = makeWebHandler(
      { apiKeys: [apiKey] },
      {
        router: h.router,
        delivery: h.delivery,
        webhooks: {
          handshake: () => Effect.fail(new WebhookError({ code: "unknown_instance" })),
          ingest: () => Effect.void,
        },
      },
    );
    const post = (path: string, input: object, authorized = true) =>
      web.handler(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
            ...(authorized ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(input),
        }),
      );
    try {
      const input = {
        recipient: { type: "phone", phoneNumber: "+998901234567" },
        purpose: "login",
        contextId: "http-flow",
        policyId: "external",
        expiresAt: new Date(Date.now() + 890000).toISOString(),
      };
      expect((await post("/v1/delivery-operations", input, false)).status).toBe(401);
      const prepared = await post("/v1/delivery-operations", input);
      expect(prepared.status).toBe(201);
      const value = Schema.decodeUnknownSync(Schema.Struct({ operationId: Schema.String }))(
        await prepared.json(),
      );
      expect(
        (await post(`/v1/delivery-operations/${value.operationId}/code`, { code: "123456" }))
          .status,
      ).toBe(202);
      expect((await post(`/v1/delivery-operations/${value.operationId}/close`, {})).status).toBe(
        200,
      );
      expect(
        (await post(`/v1/delivery-operations/${value.operationId}/code`, { code: "123456" }))
          .status,
      ).toBe(410);
      await runQueued();
      expect(sent).toHaveLength(0);
    } finally {
      await web.dispose();
    }
  });
  it("retains terminal receipts, drains expired replay batches, and rejects old creation deadlines", async () => {
    const h = app();
    const original = request({
      recipient: { type: "phone" as const, phoneNumber: "+998901234567" },
      purpose: "login",
      contextId: "retention",
      policyId: "external",
      expiresAt: new Date(Date.now() + 890000).toISOString(),
    });
    const prepared = await Effect.runPromise(h.delivery.prepare(original));
    await close(prepared.body.operationId);
    await h.run(cleanup(h.configuration));
    expect((await Effect.runPromise(h.delivery.prepare(original))).replayed).toBe(true);
    await h.run(
      h.pg`INSERT INTO otp_router.delivery_idempotency(identity,fingerprint,code_fingerprint,operation_id,response,created_at,retain_until) SELECT 'retention-' || value::text,i.fingerprint,NULL,i.operation_id,i.response,clock_timestamp()-interval '8 days',clock_timestamp()-interval '1 day' FROM generate_series(1,1005) AS series(value) CROSS JOIN LATERAL (SELECT * FROM otp_router.delivery_idempotency LIMIT 1) i`,
    );
    await h.run(cleanup(h.configuration));
    expect(
      await h.run(
        single(
          Schema.Struct({ count: Schema.Int }),
          h.pg`SELECT count(*)::int AS count FROM otp_router.delivery_idempotency WHERE identity LIKE 'retention-%'`,
        ),
      ),
    ).toEqual({ count: 0 });
    const expired = {
      ...original,
      input: { ...original.input, expiresAt: new Date(Date.now() - 1000).toISOString() },
      key: randomUUID(),
    };
    expect(await Effect.runPromise(h.delivery.prepare(expired).pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
      failure: { code: "invalid_request" },
    });
    expect(await counts()).toMatchObject({ attempts: 0, secrets: 0, sends: 0 });
  });
});
