import { describe, expect, it } from "vitest";
import { createClient, OtpRouterApiError, type ChallengeDecodeDto } from "./index.js";

const configuration = {
  baseUrl: "https://router.example/proxy/",
  bearerToken: "backend-secret",
  projectId: "demo",
};
const input = {
  recipient: { type: "phone" as const, phoneNumber: "+998901234567" },
  purpose: "login",
  contextId: "session",
  policyId: "login",
};
const snapshot: ChallengeDecodeDto = {
  projectId: "demo",
  operationId: "operation",
  challengeId: "challenge",
  revision: 1,
  state: "queued",
  reason: null,
  channel: null,
  provider: null,
  expiresAt: "2026-09-29T10:00:00Z",
  serverTime: "2026-09-29T09:55:00Z",
  actions: {
    verify: { allowed: true },
    resend: { allowed: false },
    next: { allowed: false },
    cancel: { allowed: true },
    select: { allowed: false, choices: [] },
  },
};

describe("Promise HTTP client transport", () => {
  it("encodes paths, JSON, queries and explicit keys and preserves replay metadata", async () => {
    const requests: Request[] = [];
    const client = createClient({
      ...configuration,
      fetch: async (url, init) => {
        requests.push(new Request(url, init));
        return Response.json(snapshot, {
          status: 201,
          headers: { "Idempotency-Replayed": "true", "X-Request-Id": "trace" },
        });
      },
    });
    const result = await client.createChallenge(input, { idempotencyKey: "same-key" });
    const request = requests[0];
    expect(request?.url).toBe("https://router.example/proxy/v1/projects/demo/challenges");
    expect(request?.headers.get("authorization")).toBe("Bearer backend-secret");
    expect(request?.headers.get("idempotency-key")).toBe("same-key");
    expect(await request?.json()).toEqual(input);
    expect(result).toMatchObject({
      data: snapshot,
      status: 201,
      replayed: true,
      requestId: "trace",
    });
    const readClient = createClient({
      ...configuration,
      fetch: async (url, init) => {
        requests.push(new Request(url, init));
        return Response.json({ operations: [], nextCursor: null });
      },
    });
    await readClient.listOperations({ cursor: "a+/=?", limit: 5 });
    expect(new URL(requests[1]?.url ?? "").searchParams.get("cursor")).toBe("a+/=?");
    expect(new URL(requests[1]?.url ?? "").searchParams.get("limit")).toBe("5");
    const idClient = createClient({
      ...configuration,
      fetch: async (url, init) => {
        requests.push(new Request(url, init));
        return Response.json(snapshot);
      },
    });
    await idClient.getChallenge("id/with ?#");
    expect(requests[2]?.url).toBe(
      "https://router.example/proxy/v1/projects/demo/challenges/id%2Fwith%20%3F%23",
    );
  });

  it("rejects invalid keys, payloads and query bounds before sending", async () => {
    let calls = 0;
    const client = createClient({
      ...configuration,
      fetch: async () => {
        calls += 1;
        return Response.json(snapshot);
      },
    });
    await expect(
      client.createChallenge(input, { idempotencyKey: "contains whitespace" }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(
      client.verifyChallenge(
        "challenge",
        { code: "123", purpose: "login", contextId: "session" },
        { idempotencyKey: "key" },
      ),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(client.listEvents({ limit: 101 })).rejects.toMatchObject({
      kind: "invalid_request",
    });
    for (const send of [client.sendChallenge, client.sendDelivery]) {
      await expect(
        Reflect.apply(send, undefined, [
          "operation",
          { action: "oops" },
          { idempotencyKey: "key" },
        ]),
      ).rejects.toMatchObject({ kind: "invalid_request" });
    }
    expect(calls).toBe(0);
  });

  it("does not start a mutation when the caller already aborted", async () => {
    let calls = 0;
    const client = createClient({
      ...configuration,
      fetch: async () => {
        calls += 1;
        return Response.json(snapshot, { status: 201 });
      },
    });
    await expect(
      client.createChallenge(input, { idempotencyKey: "cancelled", signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(calls).toBe(0);
  });

  it("isolates response metadata across overlapping requests and subsequent failures", async () => {
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const client = createClient({
      ...configuration,
      fetch: async (url) => {
        const path = new Request(url).url;
        if (path.endsWith("/lost")) throw new Error("Connection lost");
        if (path.endsWith("/fast")) {
          return Response.json({}, { headers: { "X-Request-Id": "fast" } });
        }
        return new Response(
          new ReadableStream(
            {
              async pull(controller) {
                reading.resolve();
                await release.promise;
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      error: { code: "unauthorized", message: "Unauthorized", requestId: "slow" },
                    }),
                  ),
                );
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Replayed": "true",
              "Retry-After": "7",
            },
          },
        );
      },
    });
    const slow = client.getChallenge("slow").catch((error: unknown) => error);
    await reading.promise;
    try {
      await expect(client.getChallenge("fast")).rejects.toMatchObject({
        kind: "invalid_response",
        response: { status: 200, requestId: "fast", replayed: false, retryAfter: null },
      });
    } finally {
      release.resolve();
    }
    expect(await slow).toMatchObject({
      code: "unauthorized",
      status: 401,
      replayed: true,
      retryAfter: "7",
    });
    await expect(client.getChallenge("lost")).rejects.toMatchObject({
      kind: "transport",
      response: undefined,
    });
  });

  it("returns discriminated API errors with retry metadata and never retries mutations", async () => {
    let calls = 0;
    const client = createClient({
      ...configuration,
      fetch: async () => {
        calls += 1;
        return Response.json(
          {
            error: {
              code: "incorrect_code",
              reason: "locked",
              message: "Code rejected",
              requestId: "request-1",
            },
          },
          { status: 422, headers: { "Idempotency-Replayed": "true", "Retry-After": "10" } },
        );
      },
    });
    const error: unknown = await client
      .verifyChallenge(
        "challenge",
        { code: "000123", purpose: "login", contextId: "session" },
        { idempotencyKey: "verify-key" },
      )
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(OtpRouterApiError);
    if (!(error instanceof OtpRouterApiError)) throw new Error("Expected API error");
    expect(error).toMatchObject({
      code: "incorrect_code",
      status: 422,
      requestId: "request-1",
      replayed: true,
      retryAfter: "10",
    });
    if (error.error.code !== "incorrect_code") throw new Error("Expected incorrect code DTO");
    expect(error.error.reason).toBe("locked");
    expect(calls).toBe(1);

    const invalidRecipient = createClient({
      ...configuration,
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "invalid_recipient",
              reason: "locked",
              message: "Invalid recipient",
              requestId: "request-2",
            },
          },
          { status: 422 },
        ),
    });
    const rejected: unknown = await invalidRecipient
      .createChallenge(input, { idempotencyKey: "key" })
      .catch((failure: unknown) => failure);
    expect(rejected).toBeInstanceOf(OtpRouterApiError);
    if (!(rejected instanceof OtpRouterApiError)) throw new Error("Expected API error");
    expect(rejected.error.code).toBe("invalid_recipient");
    expect(rejected.error).not.toHaveProperty("reason");
  });

  it("distinguishes malformed responses, lost connections and server errors without retrying", async () => {
    for (const outcome of ["malformed", "lost", "server"] as const) {
      let calls = 0;
      const client = createClient({
        ...configuration,
        fetch: async () => {
          calls += 1;
          if (outcome === "lost") throw new Error("network detail containing backend-secret");
          if (outcome === "server")
            return Response.json(
              {
                error: {
                  code: "internal_error",
                  message: "Internal error",
                  requestId: "request-2",
                },
              },
              { status: 500 },
            );
          return Response.json({ challengeId: "incomplete" }, { status: 201 });
        },
      });
      await expect(
        client.createChallenge(input, { idempotencyKey: "retain-this-key" }),
      ).rejects.toMatchObject(
        outcome === "server"
          ? { code: "internal_error", status: 500 }
          : { kind: outcome === "lost" ? "transport" : "invalid_response" },
      );
      expect(calls).toBe(1);
    }
  });

  it("aborts in-flight requests and enforces a deadline without another send", async () => {
    for (const kind of ["aborted", "timeout"] as const) {
      const entered = Promise.withResolvers<void>();
      const controller = new AbortController();
      let calls = 0;
      const client = createClient({
        ...configuration,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            calls += 1;
            init?.signal?.addEventListener("abort", () => reject(new Error("interrupted")), {
              once: true,
            });
            entered.resolve();
          }),
      });
      const pending = client.createChallenge(input, {
        idempotencyKey: "retain-on-interrupt",
        signal: controller.signal,
        timeoutMs: kind === "timeout" ? 20 : 10_000,
      });
      const outcome = pending.catch((error: unknown) => error);
      await entered.promise;
      if (kind === "aborted") controller.abort();
      expect(await outcome).toMatchObject({ kind });
      expect(calls).toBe(1);
    }
  });
});
