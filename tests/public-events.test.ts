import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Redacted, Schema } from "effect";
import { Webhook } from "standardwebhooks";
import { ChallengeEvent, Snapshot } from "../packages/engine/src/challenges/contracts.js";
import { decrypt } from "../packages/engine/src/challenges/crypto.js";
import { createChallenge } from "../packages/engine/src/challenges/create.js";
import { challengeTransaction } from "../packages/engine/src/challenges/transaction.js";
import { cleanup } from "../packages/engine/src/challenges/cleanup.js";
import { rows, single } from "../packages/engine/src/database/query.js";
import { dispatchGate } from "../packages/engine/src/delivery/dispatch.js";
import { recordOutcome } from "../packages/engine/src/delivery/outcomes.js";
import { ingestEvents, recordAccepted } from "../packages/engine/src/delivery/callbacks.js";
import {
  notifyChallenge,
  recoverNotifications,
  replayNotification,
} from "../packages/engine/src/notifications/send.js";
import { FakeProvider } from "../packages/engine/src/providers/fake.js";
import { ProviderInstanceIdSchema } from "../packages/engine/src/providers/contract.js";
import {
  DeliveryJob,
  deliveryQueue,
  notificationQueue,
} from "../packages/engine/src/queue/jobs.js";
import { startWorkers } from "../packages/engine/src/worker/run.js";
import { RouterConfig } from "../packages/engine/src/config/runtime.js";

import { findSecrets } from "../packages/engine/src/challenges/store.js";
import {
  applySnapshot,
  initializeReceiver,
  receiveWebhook,
} from "../examples/webhook-receiver/receiver.js";
import {
  startPostgres,
  startRuntime,
  type IntegrationRuntime,
  type PostgresFixture,
} from "./fixture.js";

const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
const ring = (n: number) => ({
  active: "a",
  keys: { a: Buffer.alloc(32, n).toString("base64url") },
});
const provider = (id: string) =>
  FakeProvider.make({
    instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)(id),
    enabled: true,
    settingsFingerprint: id,
    config: { outcome: "accepted", callbackSecret: Redacted.make("callback-secret") },
    templates: {},
  });
let database: PostgresFixture | undefined;
let runtime: IntegrationRuntime | undefined;
let server: Server | undefined;
let responseStatus = 503;
let receivedReady = Promise.withResolvers<void>();
let notifyAfter = Number.POSITIVE_INFINITY;
const received: Array<{ body: string; headers: Record<string, string> }> = [];
const app = () => {
  if (runtime === undefined) throw new Error("Runtime missing");
  return runtime;
};
const create = async () =>
  Schema.decodeUnknownSync(Snapshot)(
    (
      await Effect.runPromise(
        app().router.create({
          key: randomUUID(),
          requestId: randomUUID(),
          input: {
            recipient: { type: "phone", phoneNumber: "+998901234567" },
            purpose: "login",
            contextId: "binding",
            policyId: "login",
          },
        }),
      )
    ).body,
  );
const status = async (id: string) =>
  Schema.decodeUnknownSync(Snapshot)((await Effect.runPromise(app().router.status(id))).body);
const events = async (id: string) => {
  const harness = app();
  const stored = await harness.run(
    rows(
      Schema.Struct({ body: Schema.String }),
      harness.pg`SELECT body FROM otp_router.challenge_events WHERE challenge_id = ${id} ORDER BY revision`,
    ),
  );
  return stored.map(({ body }) => Schema.decodeUnknownSync(ChallengeEvent)(JSON.parse(body)));
};
const gate = async () => {
  const harness = app();
  const job = (await harness.queue.fetch<unknown>(deliveryQueue))[0];
  if (job === undefined) throw new Error("Delivery missing");
  const payload = Schema.decodeUnknownSync(DeliveryJob)(job.data);
  await harness.run(dispatchGate(harness.configuration, payload));
  await harness.queue.complete(deliveryQueue, job.id);
  return payload;
};
const outcome = (id: string, state: "accepted" | "failed" | "uncertain") =>
  app().run(
    recordOutcome(app().configuration, id, {
      state,
      acceptance:
        state === "accepted" ? "accepted" : state === "failed" ? "not_accepted" : "unknown",
    }),
  );
const resend = async (id: string) => {
  const harness = app();
  await harness.run(
    harness.pg`UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() WHERE id = ${id}`,
  );
  await Effect.runPromise(
    harness.router.deliver({
      challengeId: id,
      key: randomUUID(),
      requestId: randomUUID(),
      input: { action: "resend" },
    }),
  );
  return gate();
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers: Record<string, string> = {};
      for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"])
        headers[name] = String(request.headers[name]);
      received.push({ body: Buffer.concat(chunks).toString("utf8"), headers });
      response.writeHead(responseStatus).end();
      if (received.length >= notifyAfter) receivedReady.resolve();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Listener missing");
  database = await startPostgres();
  runtime = await startRuntime(database.databaseUrl, {
    settings: {
      crypto: {
        deploymentId: "events",
        encryption: ring(1),
        verification: ring(2),
        fingerprint: ring(3),
        recipientKey: Buffer.alloc(32, 4).toString("base64url"),
      },
      webhook: { url: `http://127.0.0.1:${address.port}`, signingSecret: secret },
      defaultLocale: "en",
      fallbackLocales: [],
      policies: {
        login: { providerInstanceIds: ["primary", "secondary"], maxIncorrectGuesses: 2 },
      },
      providerLabels: { primary: "Primary channel", secondary: "Backup channel" },
      purposes: { login: ["login"] },
      deploymentSendLimit15m: 100,
      deploymentSendLimit24h: 1000,
    },
    providers: [provider("primary"), provider("secondary")],
  });
  await runtime.run(initializeReceiver);
}, 30000);
beforeEach(async () => {
  await app().reset();
  await app().run(app().pg`TRUNCATE webhook_receipts,webhook_challenges`);
  received.length = 0;
  receivedReady = Promise.withResolvers<void>();
  notifyAfter = Number.POSITIVE_INFINITY;
  responseStatus = 503;
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await runtime?.close();
  await database?.close();
  await new Promise<void>((resolve, reject) => {
    if (server === undefined) resolve();
    else server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

describe("public snapshots and transactional events", () => {
  it("coalesces fallback outcomes, preserves valid acceptance across resends, and ignores duplicate callbacks", async () => {
    const harness = app();
    const created = await create();
    expect(created).toMatchObject({
      revision: 1,
      state: "queued",
      provider: null,
      channel: null,
      reason: null,
    });
    expect((await events(created.challengeId))[0]?.challenge).toEqual(created);
    const first = await gate();
    expect(await status(created.challengeId)).toMatchObject({
      revision: 2,
      state: "sending",
      provider: null,
    });
    await outcome(first.deliveryId, "failed");
    expect((await events(created.challengeId)).map((event) => event.challenge.state)).toEqual([
      "queued",
      "sending",
      "sending",
    ]);
    const second = await gate();
    await outcome(second.deliveryId, "accepted");
    const accepted = await status(created.challengeId);
    expect(accepted).toMatchObject({
      state: "accepted",
      provider: { id: "secondary", label: "Backup channel" },
      channel: "fake",
    });
    const uncertain = await resend(created.challengeId);
    await outcome(uncertain.deliveryId, "uncertain");
    expect(await status(created.challengeId)).toMatchObject({
      state: "accepted",
      provider: accepted.provider,
    });
    const failed = await resend(created.challengeId);
    await outcome(failed.deliveryId, "failed");
    expect(await status(created.challengeId)).toMatchObject({
      state: "accepted",
      provider: accepted.provider,
    });
    const callback = {
      deduplicationKey: "final-failure",
      correlationReference: second.deliveryId,
      status: "failed" as const,
    };
    await harness.run(ingestEvents(harness.configuration, "secondary", [callback]));
    expect(await status(created.challengeId)).toMatchObject({ state: "uncertain", provider: null });
    const before = await events(created.challengeId);
    await harness.run(
      ingestEvents(harness.configuration, "secondary", [
        callback,
        { ...callback, deduplicationKey: "same-evidence" },
      ]),
    );
    expect(await events(created.challengeId)).toEqual(before);
    await harness.run(
      ingestEvents(harness.configuration, "secondary", [
        {
          deduplicationKey: "late-delivery",
          correlationReference: second.deliveryId,
          status: "delivered",
        },
      ]),
    );
    expect(await status(created.challengeId)).toMatchObject({
      state: "accepted",
      provider: accepted.provider,
    });
    const all = await events(created.challengeId);
    expect(all.map((event) => event.challenge.revision)).toEqual(all.map((_, index) => index + 1));
  });

  it("does not fallback from uncertainty; late acceptance resolves it without another send", async () => {
    const harness = app();
    const created = await create();
    const job = await gate();
    await outcome(job.deliveryId, "uncertain");
    expect(await status(created.challengeId)).toMatchObject({
      state: "uncertain",
      reason: "delivery_uncertain",
      provider: null,
    });
    expect(await harness.queue.fetch(deliveryQueue)).toHaveLength(0);
    await harness.run(
      recordAccepted(harness.configuration, job.deliveryId, { providerRequestId: "late" }),
    );
    const accepted = await status(created.challengeId);
    expect(accepted).toMatchObject({ state: "accepted", provider: { id: "primary" } });
    expect((await status(created.challengeId)).revision).toBe(accepted.revision);
    await harness.run(
      ingestEvents(harness.configuration, "primary", [
        { deduplicationKey: "failed", correlationReference: "late", status: "failed" },
      ]),
    );
    expect(await status(created.challengeId)).toMatchObject({ state: "sending", provider: null });
    expect(await harness.queue.fetch(deliveryQueue)).toHaveLength(1);
  });

  it("rolls back events and both job types when the surrounding transition aborts", async () => {
    const harness = app();
    const result = await harness.run(
      challengeTransaction(
        harness.configuration,
        createChallenge(harness.configuration, {
          key: randomUUID(),
          requestId: randomUUID(),
          input: {
            recipient: { type: "phone", phoneNumber: "+998901234567" },
            purpose: "login",
            contextId: "binding",
            policyId: "login",
          },
        }).pipe(Effect.andThen(Effect.fail("abort"))),
      ).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(
      await harness.run(
        single(
          Schema.Struct({ count: Schema.Int }),
          harness.pg`SELECT count(*)::int AS count FROM otp_router.challenge_events`,
        ),
      ),
    ).toEqual({ count: 0 });
    expect(await harness.queue.fetch(notificationQueue)).toHaveLength(0);
    expect(await harness.queue.fetch(deliveryQueue)).toHaveLength(0);
  });

  it.each(["cancelled", "expired", "locked", "verified"] as const)(
    "publishes %s once, with secret erasure and terminal actions",
    async (terminal) => {
      const harness = app();
      const created = await create();
      if (terminal === "cancelled")
        await Effect.runPromise(
          harness.router.cancel({
            challengeId: created.challengeId,
            key: randomUUID(),
            requestId: randomUUID(),
            input: {},
          }),
        );
      else if (terminal === "expired") {
        await harness.run(
          harness.pg`UPDATE otp_router.challenges SET expires_at = clock_timestamp() WHERE id = ${created.challengeId}`,
        );
        await harness.run(cleanup(harness.configuration));
      } else {
        const saved = await harness.run(findSecrets(created.challengeId));
        const code = await Effect.runPromise(
          decrypt(harness.configuration.settings.crypto, created.challengeId, "code", saved.code),
        );
        const input = {
          purpose: "login",
          contextId: "binding",
          code: terminal === "verified" ? code : code === "000000" ? "111111" : "000000",
        };
        await Effect.runPromise(
          harness.router.verify({
            challengeId: created.challengeId,
            key: randomUUID(),
            requestId: randomUUID(),
            input,
          }),
        );
        if (terminal === "locked")
          await Effect.runPromise(
            harness.router.verify({
              challengeId: created.challengeId,
              key: randomUUID(),
              requestId: randomUUID(),
              input,
            }),
          );
      }
      const final = await status(created.challengeId);
      expect(final).toMatchObject({
        state: terminal === "verified" ? "verified" : "failed",
        reason: terminal === "verified" ? null : terminal,
        actions: { verify: { allowed: false }, resend: { allowed: false } },
      });
      const all = await events(created.challengeId);
      expect(all).toHaveLength(2);
      expect(all[1]?.challenge).toMatchObject({
        revision: 2,
        state: final.state,
        reason: final.reason,
      });
      expect((await status(created.challengeId)).revision).toBe(2);
      expect(
        await harness.run(
          rows(
            Schema.Struct({ challenge_id: Schema.String }),
            harness.pg`SELECT challenge_id FROM otp_router.challenge_secrets WHERE challenge_id = ${created.challengeId}`,
          ),
        ),
      ).toHaveLength(0);
    },
  );
});

it("retries immutable signed events independently, recovers missing jobs, retains exhausted work, and safely replays", async () => {
  const harness = app();
  const created = await create();
  const event = (await events(created.challengeId))[0];
  if (event === undefined) throw new Error("Event missing");
  const id = event.eventId;
  vi.useFakeTimers({ toFake: ["Date"] });
  const signingTime = Date.now();
  await Promise.all([
    harness.run(notifyChallenge(harness.configuration, id)),
    harness.run(notifyChallenge(harness.configuration, id)),
  ]);
  expect(received).toHaveLength(1);
  const first = received[0];
  if (first === undefined) throw new Error("Receipt missing");
  expect(new Webhook(secret).verify(first.body, first.headers)).toEqual(event);
  expect(first.headers["webhook-signature"]).toMatch(/^v1,/);
  await harness.run(
    harness.pg`UPDATE otp_router.notifications SET next_attempt_at = clock_timestamp() WHERE event_id = ${id}`,
  );
  await harness.queue.deleteAllJobs();
  await harness.run(recoverNotifications);
  expect(await harness.queue.fetch(notificationQueue)).toHaveLength(1);
  responseStatus = 204;
  vi.setSystemTime(signingTime + 1000);
  await harness.run(notifyChallenge(harness.configuration, id));
  expect(received).toHaveLength(2);
  expect(received[1]?.body).toBe(first.body);
  expect(received[1]?.headers["webhook-timestamp"]).not.toBe(first.headers["webhook-timestamp"]);
  expect(received[1]?.headers["webhook-signature"]).not.toBe(first.headers["webhook-signature"]);
  expect(received[1]?.headers["webhook-id"]).toBe(id);
  await harness.run(
    harness.pg`UPDATE otp_router.notifications SET state = 'delivering', attempts = 12, lease_until = clock_timestamp() WHERE event_id = ${id}`,
  );
  await harness.run(recoverNotifications);
  expect(
    await harness.run(
      single(
        Schema.Struct({ state: Schema.String }),
        harness.pg`SELECT state FROM otp_router.notifications WHERE event_id = ${id}`,
      ),
    ),
  ).toEqual({ state: "failed" });
  // Retained failed events must survive deletion of their challenge history.
  await Effect.runPromise(
    harness.router.cancel({
      challengeId: created.challengeId,
      key: randomUUID(),
      requestId: randomUUID(),
      input: {},
    }),
  );
  await harness.run(
    harness.pg`UPDATE otp_router.challenges SET terminal_at = clock_timestamp() - interval '8 days' WHERE id = ${created.challengeId}`,
  );
  await harness.run(
    harness.pg`UPDATE otp_router.challenge_events SET occurred_at = clock_timestamp() - interval '8 days' WHERE challenge_id = ${created.challengeId}`,
  );
  await harness.run(cleanup(harness.configuration));
  expect((await events(created.challengeId)).some((stored) => stored.eventId === id)).toBe(true);
  expect(await harness.run(replayNotification(id))).toBe(true);
  await harness.run(notifyChallenge(harness.configuration, id));
  expect(received[2]?.body).toBe(first.body);
  expect(
    await harness.run(
      single(
        Schema.Struct({ count: Schema.Int }),
        harness.pg`SELECT count(*)::int AS count FROM otp_router.deliveries WHERE challenge_id = ${created.challengeId}`,
      ),
    ),
  ).toEqual({ count: 0 });
});

it("durably deduplicates authenticated receipts and never overwrites a higher revision with an older event or creation response", async () => {
  const harness = app();
  const created = await create();
  const job = await gate();
  await outcome(job.deliveryId, "accepted");
  const all = await events(created.challengeId);
  responseStatus = 204;
  for (const event of [...all].reverse()) {
    await harness.run(notifyChallenge(harness.configuration, event.eventId));
    const receipt = received.at(-1);
    if (receipt === undefined) throw new Error("Receipt missing");
    await harness.run(receiveWebhook({ ...receipt, secret }));
    await harness.run(receiveWebhook({ ...receipt, secret }));
  }
  await harness.run(applySnapshot(created));
  expect(
    await harness.run(
      single(
        Schema.Struct({ count: Schema.Int }),
        harness.pg`SELECT count(*)::int AS count FROM webhook_receipts`,
      ),
    ),
  ).toEqual({ count: 3 });
  expect(
    await harness.run(
      single(
        Schema.Struct({ revision: Schema.Int, snapshot: Snapshot }),
        harness.pg`SELECT revision,snapshot FROM webhook_challenges WHERE challenge_id = ${created.challengeId}`,
      ),
    ),
  ).toMatchObject({ revision: 3, snapshot: { state: "accepted" } });
  const receipt = received[0];
  if (receipt === undefined) throw new Error("Receipt missing");
  expect(
    (
      await harness.run(
        receiveWebhook({ ...receipt, body: `${receipt.body} `, secret }).pipe(Effect.result),
      )
    )._tag,
  ).toBe("Failure");
});

it("runs notification workers independently and retains an expiry job for every challenge", async () => {
  const harness = app();
  responseStatus = 204;
  notifyAfter = 6;
  await harness.run(
    Effect.gen(function* () {
      yield* startWorkers({ concurrency: 4, shutdownGraceMs: 30000 }).pipe(
        Effect.provideService(RouterConfig, harness.configuration),
      );
      for (let index = 0; index < 2; index++)
        yield* createChallenge(harness.configuration, {
          key: randomUUID(),
          requestId: randomUUID(),
          input: {
            recipient: { type: "phone", phoneNumber: "+998901234567" },
            purpose: "login",
            contextId: "binding",
            policyId: "login",
          },
        });
      yield* Effect.promise(() => receivedReady.promise).pipe(Effect.timeout("10 seconds"));
    }).pipe(Effect.scoped),
  );
  expect(
    await harness.run(
      single(
        Schema.Struct({ count: Schema.Int }),
        harness.pg`SELECT count(*)::int AS count FROM pgboss.job WHERE name = 'otp-expiry-v1' AND state = 'created'`,
      ),
    ),
  ).toEqual({ count: 2 });
  expect(
    await harness.run(
      single(
        Schema.Struct({ count: Schema.Int }),
        harness.pg`SELECT count(*)::int AS count FROM otp_router.notifications WHERE state = 'delivered'`,
      ),
    ),
  ).toEqual({ count: 6 });
  for (const receipt of received)
    expect(
      Schema.decodeUnknownSync(ChallengeEvent)(
        new Webhook(secret).verify(receipt.body, receipt.headers),
      ).type,
    ).toBe("challenge.updated");
});

it("publishes only the final snapshot when acceptance and early failure evidence commit together", async () => {
  const harness = app();
  const created = await create();
  const job = await gate();
  await harness.run(
    recordAccepted(harness.configuration, job.deliveryId, {
      providerRequestId: "inline-reference",
      deliveryEvent: {
        deduplicationKey: "inline-failure",
        correlationReference: "inline-reference",
        status: "failed",
      },
    }),
  );
  const all = await events(created.challengeId);
  expect(all.map((event) => event.challenge.state)).toEqual(["queued", "sending", "sending"]);
  expect(all.at(-1)?.challenge).toMatchObject({ provider: null, channel: null });
  expect(await harness.queue.fetch(deliveryQueue)).toHaveLength(1);
});
