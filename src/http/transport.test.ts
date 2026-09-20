import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  type ChallengeMutation,
  type CreateInput,
  type DeliveryInput,
  DomainError,
  ErrorBody,
  type Mutation,
  Router,
  type Snapshot,
  type VerifyInput,
} from "../challenges/contracts.js";
import { openApiDocument } from "./api.js";
import { makeWebHandler } from "./transport.js";
import { WebhookError, WebhookHandler } from "./webhooks.js";

const API_KEY = "test-api-key-with-at-least-thirty-two-bytes";

const snapshot: Snapshot = {
  challengeId: "challenge_1",
  purpose: "login",
  contextId: "flow_1",
  createdAt: "2026-09-20T10:00:00.000Z",
  expiresAt: "2026-09-20T10:05:00.000Z",
  serverTime: "2026-09-20T10:00:00.000Z",
  verificationState: "active",
  delivery: {
    deliveryId: "delivery_1",
    channel: "sms",
    state: "pending",
    routing: "pending",
  },
  actions: {
    verify: { allowed: true },
    resend: { allowed: false, reason: "cooldown_active", availableAt: "2026-09-20T10:00:30.000Z" },
    next: { allowed: false, reason: "no_next_provider" },
    select: { allowed: false, reason: "manual_selection_disabled", choices: [] },
    cancel: { allowed: true },
  },
};

describe("HTTP transport", () => {
  const createRequests: Array<Mutation<CreateInput>> = [];
  const statusRequests: Array<string> = [];
  const verifyRequests: Array<ChallengeMutation<VerifyInput>> = [];
  const deliveryRequests: Array<ChallengeMutation<DeliveryInput>> = [];
  const cancelRequests: Array<ChallengeMutation<Record<string, never>>> = [];
  const callbackBodies: Array<Uint8Array> = [];
  let createMode: "success" | "replay" | "rate-limited" = "success";
  let callbackAvailable = true;

  const router = Router.of({
    create: (request) => {
      createRequests.push(request);
      if (createMode === "rate-limited") {
        return Effect.fail(
          new DomainError({
            code: "rate_limited",
            retryAt: new Date(Date.now() + 120_000).toISOString(),
          }),
        );
      }
      return Effect.succeed({
        status: 201,
        body: snapshot,
        replayed: createMode === "replay",
      });
    },
    status: (challengeId) => {
      statusRequests.push(challengeId);
      return Effect.succeed({ status: 200, body: snapshot, replayed: false });
    },
    verify: (request) => {
      verifyRequests.push(request);
      return Effect.succeed({
        status: 200,
        body: {
          verificationId: "verification_1",
          challengeId: "challenge_1",
          purpose: "login",
          contextId: "flow_1",
          verifiedAt: "2026-09-20T10:01:00.000Z",
        },
        replayed: false,
      });
    },
    deliver: (request) => {
      deliveryRequests.push(request);
      return Effect.succeed({
        status: 202,
        body: { deliveryId: "delivery_2", challenge: snapshot },
        replayed: false,
      });
    },
    cancel: (request) => {
      cancelRequests.push(request);
      return Effect.succeed({ status: 200, body: snapshot, replayed: false });
    },
  });

  const webhooks = WebhookHandler.of({
    handshake: (input) =>
      input.providerInstanceId === "meta-primary"
        ? Effect.succeed({ body: input.query["hub.challenge"]?.toString() ?? "" })
        : Effect.fail(new WebhookError({ code: "unknown_instance" })),
    ingest: (input) => {
      if (!callbackAvailable) {
        return Effect.fail(new WebhookError({ code: "temporarily_unavailable" }));
      }
      callbackBodies.push(input.body);
      return Effect.void;
    },
  });

  const server = makeWebHandler(
    { apiKeys: [API_KEY], webhookBodyLimitBytes: 64 },
    { router, webhooks },
  );

  beforeAll(() => {
    createRequests.length = 0;
    statusRequests.length = 0;
    verifyRequests.length = 0;
    deliveryRequests.length = 0;
    cancelRequests.length = 0;
    callbackBodies.length = 0;
  });

  afterAll(async () => {
    await server.dispose();
  });

  const createRequest = (body: string, headers: Readonly<Record<string, string>> = {}) =>
    new Request("http://router.test/v1/challenges", {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": "operation_1",
        ...headers,
      },
      body,
    });

  const validCreate = JSON.stringify({
    recipient: { type: "phone", phoneNumber: "+998901234567" },
    purpose: "login",
    contextId: "flow_1",
    policyId: "default",
  });

  it("authenticates before challenge access and uses server request IDs", async () => {
    const before = statusRequests.length;
    const first = await server.handler(
      new Request("http://router.test/v1/challenges/challenge_1", {
        headers: { authorization: "Bearer wrong", "x-request-id": "caller-controlled" },
      }),
    );
    const second = await server.handler(
      new Request("http://router.test/v1/challenges/challenge_1"),
    );

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(statusRequests).toHaveLength(before);
    const firstBody = Schema.decodeUnknownSync(ErrorBody)(await first.json());
    const secondBody = Schema.decodeUnknownSync(ErrorBody)(await second.json());
    expect(firstBody.error.requestId).not.toBe("caller-controlled");
    expect(firstBody.error.requestId).not.toBe(secondBody.error.requestId);
  });

  it("passes a strict validated create request to Router and returns its committed result", async () => {
    createMode = "success";
    const response = await server.handler(createRequest(validCreate));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("idempotency-replayed")).toBeNull();
    expect(await response.json()).toEqual(snapshot);
    expect(createRequests.at(-1)?.key).toBe("operation_1");
    expect(createRequests.at(-1)?.input).toEqual({
      recipient: { type: "phone", phoneNumber: "+998901234567" },
      purpose: "login",
      contextId: "flow_1",
      policyId: "default",
    });
    expect(createRequests.at(-1)?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("wires status, verification, delivery, and cancellation to their Router operations", async () => {
    const headers = {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": "operation_2",
    };
    const status = await server.handler(
      new Request("http://router.test/v1/challenges/challenge_1", {
        headers: { authorization: `Bearer ${API_KEY}` },
      }),
    );
    const verify = await server.handler(
      new Request("http://router.test/v1/challenges/challenge_1/verify", {
        method: "POST",
        headers,
        body: JSON.stringify({ code: "123456", purpose: "login", contextId: "flow_1" }),
      }),
    );
    const delivery = await server.handler(
      new Request("http://router.test/v1/challenges/challenge_1/deliveries", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "select", choice: { type: "channel", channel: "sms" } }),
      }),
    );
    const cancel = await server.handler(
      new Request("http://router.test/v1/challenges/challenge_1/cancel", {
        method: "POST",
        headers,
        body: "{}",
      }),
    );

    expect([status.status, verify.status, delivery.status, cancel.status]).toEqual([
      200, 200, 202, 200,
    ]);
    expect(statusRequests.at(-1)).toBe("challenge_1");
    expect(verifyRequests.at(-1)).toMatchObject({
      challengeId: "challenge_1",
      key: "operation_2",
      input: { code: "123456", purpose: "login", contextId: "flow_1" },
    });
    expect(deliveryRequests.at(-1)).toMatchObject({
      challengeId: "challenge_1",
      key: "operation_2",
      input: { action: "select", choice: { type: "channel", channel: "sms" } },
    });
    expect(cancelRequests.at(-1)).toMatchObject({
      challengeId: "challenge_1",
      key: "operation_2",
      input: {},
    });
  });

  it("rejects duplicate, unknown, compressed, missing-key, and streamed oversized input", async () => {
    const before = createRequests.length;
    const cases = [
      createRequest(
        '{"recipient":{"type":"phone","phoneNumber":"+998901234567"},"purpose":"login","purpose":"other","contextId":"flow_1","policyId":"default"}',
      ),
      createRequest(
        '{"recipient":{"type":"phone","phoneNumber":"+998901234567"},"purpose":"login","contextId":"flow_1","policyId":"default","extra":true}',
      ),
      createRequest(validCreate, { "content-encoding": "gzip" }),
      createRequest(validCreate, { "idempotency-key": "" }),
      createRequest(`{"padding":"${"x".repeat(17 * 1024)}"}`),
    ];
    const responses = await Promise.all(cases.map((request) => server.handler(request)));

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 413]);
    expect(createRequests).toHaveLength(before);
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("sets replay and retry headers from Router outcomes", async () => {
    createMode = "replay";
    const replay = await server.handler(createRequest(validCreate));
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");

    createMode = "rate-limited";
    const limited = await server.handler(createRequest(validCreate));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(120);
    const body = Schema.decodeUnknownSync(ErrorBody)(await limited.json());
    expect(body.error.code).toBe("rate_limited");
    createMode = "success";
  });

  it("delegates callback handshakes and acknowledges POST only after ingestion", async () => {
    const handshake = await server.handler(
      new Request("http://router.test/webhooks/meta-primary?hub.challenge=abc123"),
    );
    expect(handshake.status).toBe(200);
    expect(await handshake.text()).toBe("abc123");

    callbackAvailable = false;
    const unavailable = await server.handler(
      new Request("http://router.test/webhooks/meta-primary", {
        method: "POST",
        body: '{"event":"delivered"}',
      }),
    );
    expect(unavailable.status).toBe(503);

    callbackAvailable = true;
    const accepted = await server.handler(
      new Request("http://router.test/webhooks/meta-primary", {
        method: "POST",
        body: '{"event":"delivered"}',
      }),
    );
    expect(accepted.status).toBe(200);
    expect(new TextDecoder().decode(callbackBodies.at(-1))).toBe('{"event":"delivered"}');

    const before = callbackBodies.length;
    const oversized = await server.handler(
      new Request("http://router.test/webhooks/meta-primary", {
        method: "POST",
        body: "x".repeat(65),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(callbackBodies).toHaveLength(before);
  });

  it("generates strict OpenAPI for operations, security, and status responses", () => {
    const create = openApiDocument.paths["/v1/challenges"]?.post;
    expect(Object.keys(create?.responses ?? {})).toEqual(
      expect.arrayContaining(["201", "400", "401", "409", "413", "422", "429", "500", "503"]),
    );
    expect(create?.security).toBeDefined();
    expect(openApiDocument.paths["/webhooks/{providerInstanceId}"]?.post?.security).toEqual([]);
  });
});
