import type { SqlError } from "effect/unstable/sql/SqlError";
import { deliveryTransaction } from "../packages/engine/src/delivery/transaction.js";
import { recordOutcome } from "../packages/engine/src/delivery/outcomes.js";
import { randomUUID } from "node:crypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Configuration } from "@otp-router/engine/config";
import {
  SendAuthorizer,
  AuthorizationUnavailable,
  type AuthorizationRequest,
  type AuthorizationDecision,
} from "@otp-router/engine/delivery";
import {
  FakeProvider,
  ProviderInstance,
  ProviderInstanceIdSchema,
  ProviderRejected,
  type ProviderSendInput,
} from "@otp-router/engine/providers";
import { authorizeAttempt } from "../packages/engine/src/delivery/authorization.js";
import { dispatch, dispatchGate } from "../packages/engine/src/delivery/dispatch.js";
import { ingestEvents } from "../packages/engine/src/delivery/callbacks.js";
import { cleanup } from "../packages/engine/src/maintenance.js";
import { recoverDispatches } from "../packages/engine/src/delivery/recovery.js";
import { DeliveryJob, deliveryQueue } from "../packages/engine/src/queue/contracts.js";
import { rows } from "../packages/engine/src/database/query.js";
import { makeWebHandler } from "../apps/server/src/http/transport.js";
import { WebhookError } from "../apps/server/src/http/webhooks.js";
import {
  startPostgres,
  startRuntime,
  ageAdmission,
  type IntegrationRuntime,
  type PostgresFixture,
} from "./fixture.js";

const sent: ProviderSendInput[] = [];
const reservations = new Map<string, AuthorizationDecision>();
const requests: AuthorizationRequest[] = [];
let mode: "approve" | "lost" | "unavailable" | "deny" | "blocked" = "approve";
let rejectPrimary = false;
let entered = Promise.withResolvers<void>();
let release = Promise.withResolvers<void>();
const approve = (request: AuthorizationRequest): AuthorizationDecision => ({
  deploymentId: request.deploymentId,
  projectId: request.projectId,
  attemptId: request.attemptId,
  decision: "approved",
  reservationId: request.attemptId,
  validUntil: request.dispatchDeadline,
});
const authorizer = Layer.succeed(SendAuthorizer, {
  reserve: (request) =>
    Effect.gen(function* () {
      requests.push(request);
      if (mode === "unavailable") return yield* Effect.fail(new AuthorizationUnavailable());
      if (mode === "deny")
        return {
          deploymentId: request.deploymentId,
          projectId: request.projectId,
          attemptId: request.attemptId,
          decision: "denied" as const,
          scope: "project" as const,
          retryAt: new Date(Date.now() + 60000).toISOString(),
        };
      let decision = reservations.get(request.attemptId);
      if (decision === undefined) {
        decision = approve(request);
        reservations.set(request.attemptId, decision);
      }
      if (mode === "lost") return yield* Effect.fail(new AuthorizationUnavailable());
      if (mode === "blocked") {
        entered.resolve();
        yield* Effect.promise(() => release.promise);
      }
      return decision;
    }),
});
const provider = (id: string) =>
  Layer.effect(
    ProviderInstance,
    Effect.gen(function* () {
      const base = yield* ProviderInstance;
      return {
        ...base,
        send: (input: ProviderSendInput) =>
          Effect.gen(function* () {
            sent.push(input);
            if (id === "primary" && rejectPrimary)
              return yield* Effect.fail(
                new ProviderRejected({
                  reason: "recipient_unavailable",
                  diagnosticCode: "unclassified",
                }),
              );
            return yield* base.send(input);
          }),
      };
    }),
  ).pipe(
    Layer.provide(
      FakeProvider.make({
        instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)(id),
        enabled: true,
        compatibilityRevision: "tests",
        config: { outcome: "accepted", callbackSecret: Redacted.make("test-callback") },
        templates: {},
      }),
    ),
  );
const ring = (n: number) => ({
  active: "a",
  keys: { a: Buffer.alloc(32, n).toString("base64url") },
});
const project = {
  policyIds: ["login"],
  sendLimit15m: 10,
  sendLimit24h: 20,
  authorization: "required" as const,
};
const configuration: Configuration = {
  settings: {
    crypto: {
      deploymentId: "projects",
      encryption: ring(1),
      verification: ring(2),
      fingerprint: ring(3),
      recipientKey: Buffer.alloc(32, 4).toString("base64url"),
    },
    projects: { alpha: project, beta: project },
    defaultLocale: "en",
    fallbackLocales: [],
    policies: {
      login: {
        providerInstanceIds: ["primary", "secondary"],
        manualSelectionEnabled: true,
        managed: {},
      },
      restricted: { providerInstanceIds: ["primary"] },
    },
    purposes: { login: ["login", "restricted"] },
    deploymentSendLimit15m: 100,
    deploymentSendLimit24h: 200,
  },
  providers: [provider("primary"), provider("secondary")],
  authorizer,
};
let database: PostgresFixture | undefined;
let runtime: IntegrationRuntime | undefined;
const app = () => {
  if (runtime === undefined) throw new Error("Runtime missing");
  return runtime;
};
const input = (phoneNumber = "+998901234567") => ({
  recipient: { type: "phone" as const, phoneNumber },
  purpose: "login",
  contextId: "private-binding",
  policyId: "login",
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  code: "001234",
});
const request = <A>(projectId: string, body: A, key = randomUUID()) => ({
  projectId,
  key,
  requestId: randomUUID(),
  input: body,
});
const create = (projectId = "alpha", phone?: string) =>
  Effect.runPromise(app().delivery.create(request(projectId, input(phone))));
const job = async () => {
  const next = (await app().queue.fetch(deliveryQueue))[0];
  if (next === undefined) throw new Error("Missing delivery job");
  return Schema.decodeUnknownSync(DeliveryJob)(next.data);
};
const makeRetryDue = (id: string) =>
  app().run(
    app()
      .pg`UPDATE otp_router.delivery_attempts SET authorization_retry_at = clock_timestamp() - interval '1 second' WHERE id = ${id}`,
  );

beforeAll(async () => {
  database = await startPostgres();
  runtime = await startRuntime(database.databaseUrl, configuration);
}, 30000);
afterAll(async () => {
  await runtime?.close();
  await database?.close();
});
beforeEach(async () => {
  await app().reset();
  await app().run(
    app().pg`DELETE FROM otp_router.project_send_blocks WHERE project_id IN ('alpha','beta')`,
  );
  sent.length = 0;
  requests.length = 0;
  reservations.clear();
  mode = "approve";
  rejectPrimary = false;
  entered = Promise.withResolvers<void>();
  release = Promise.withResolvers<void>();
});

describe("project isolation and authorization", () => {
  it("isolates ownership, policies, recipient admission, replay and HTTP project grants", async () => {
    const body = input(),
      key = randomUUID();
    const alpha = await Effect.runPromise(app().delivery.create(request("alpha", body, key)));
    const beta = await Effect.runPromise(app().delivery.create(request("beta", body, key)));
    expect(alpha.body.operationId).not.toBe(beta.body.operationId);
    expect(
      (await Effect.runPromise(app().delivery.create(request("alpha", body, key)))).replayed,
    ).toBe(true);
    expect(
      await Effect.runPromise(
        app().delivery.status("beta", alpha.body.operationId).pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "operation_not_found" } });
    expect(
      await Effect.runPromise(
        app()
          .delivery.close({ ...request("beta", {}), operationId: alpha.body.operationId })
          .pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "operation_not_found" } });
    expect(
      await Effect.runPromise(
        app()
          .delivery.create(request("alpha", { ...input("+998901234568"), policyId: "restricted" }))
          .pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "policy_not_allowed" } });
    const attempt = await job();
    expect(
      await Effect.runPromise(app().history.attempt("beta", attempt.attemptId).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "operation_not_found" } });
    const keyValue = "service-principal-secret-with-at-least-32-bytes";
    const web = makeWebHandler(
      { principals: [{ id: "backend", keys: [keyValue], projectIds: ["alpha"] }] },
      {
        router: app().router,
        delivery: app().delivery,
        history: app().history,
        webhooks: {
          handshake: () => Effect.fail(new WebhookError({ code: "unknown_instance" })),
          ingest: () => Effect.fail(new WebhookError({ code: "unknown_instance" })),
        },
      },
    );
    try {
      const denied = await web.handler(
        new Request(`http://router/v1/projects/beta/delivery-operations/${beta.body.operationId}`, {
          headers: { authorization: `Bearer ${keyValue}` },
        }),
      );
      expect(denied.status).toBe(401);
      const history = await web.handler(
        new Request(
          `http://router/v1/projects/alpha/delivery-operations/${alpha.body.operationId}/attempts`,
          { headers: { authorization: `Bearer ${keyValue}` } },
        ),
      );
      expect(history.status).toBe(200);
    } finally {
      await web.dispose();
    }
  });

  it("reconciles a lost authorization response without reserving or sending twice", async () => {
    await create();
    const work = await job();
    mode = "lost";
    await app().run(dispatch(app().configuration, work));
    expect(sent).toHaveLength(0);
    expect(reservations.size).toBe(1);
    await makeRetryDue(work.attemptId);
    mode = "approve";
    await app().run(dispatch(app().configuration, work));
    await app().run(dispatch(app().configuration, work));
    expect(sent).toHaveLength(1);
    expect(reservations.size).toBe(1);
    expect(requests.map((entry) => entry.attemptId)).toEqual([work.attemptId, work.attemptId]);
    expect(await Effect.runPromise(app().history.attempt("alpha", work.attemptId))).toMatchObject({
      authorization: { state: "approved" },
      invocation: "committed",
      state: "accepted",
    });
  });

  it("authorizes fallback separately and stops the route on a project denial", async () => {
    const created = await create();
    rejectPrimary = true;
    await app().run(dispatch(app().configuration, await job()));
    mode = "deny";
    const fallback = await job();
    await app().run(dispatch(app().configuration, fallback));
    expect(sent).toHaveLength(1);
    expect(requests.map((entry) => entry.reason)).toEqual(["initial", "fallback"]);
    expect(
      await Effect.runPromise(app().history.attempt("alpha", fallback.attemptId)),
    ).toMatchObject({ authorization: { state: "denied" }, invocation: "not_invoked" });
    await ageAdmission(app());
    await app().run(
      app()
        .pg`UPDATE otp_router.delivery_operations SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id = ${created.body.operationId}`,
    );
    await Effect.runPromise(
      app().delivery.deliver({
        ...request("alpha", {
          action: "select" as const,
          choice: { type: "provider" as const, providerInstanceId: "primary" },
        }),
        operationId: created.body.operationId,
      }),
    );
    mode = "approve";
    await app().run(dispatch(app().configuration, await job()));
    expect(sent).toHaveLength(1);
  });

  it("freezes closure while late failure and resend authorization still update attempt history", async () => {
    const created = await create();
    const initial = await job();
    await app().run(dispatch(app().configuration, initial));
    await ageAdmission(app());
    await app().run(
      app()
        .pg`UPDATE otp_router.delivery_operations SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id = ${created.body.operationId}`,
    );
    await Effect.runPromise(
      app().delivery.deliver({
        ...request("alpha", { action: "resend" as const }),
        operationId: created.body.operationId,
      }),
    );
    const work = await job();
    mode = "blocked";
    const sending = app().run(dispatch(app().configuration, work));
    await entered.promise;
    try {
      const closed = await Effect.runPromise(
        app().delivery.close({ ...request("alpha", {}), operationId: created.body.operationId }),
      );
      expect(closed.body).toMatchObject({ state: "closed", provider: { id: "primary" } });
      await app().run(
        recordOutcome(app().configuration, initial.attemptId, {
          state: "failed",
          acceptance: "accepted",
          diagnosticCode: "unclassified",
        }),
      );
      release.resolve();
      await sending;
      const current = await Effect.runPromise(
        app().delivery.status("alpha", created.body.operationId),
      );
      expect({ ...current.body, serverTime: closed.body.serverTime }).toEqual(closed.body);
    } finally {
      release.resolve();
      await sending;
    }
    expect(sent).toHaveLength(1);
    expect(await Effect.runPromise(app().history.attempt("alpha", work.attemptId))).toMatchObject({
      state: "suppressed",
      authorization: { state: "approved" },
      invocation: "not_invoked",
    });
    expect(
      await Effect.runPromise(app().history.attempt("alpha", initial.attemptId)),
    ).toMatchObject({ state: "failed", acceptance: "accepted" });
  });

  it("never repeats a committed dispatch after a crash, even with durable approval", async () => {
    await create();
    const work = await job();
    await app().run(authorizeAttempt(app().configuration, work));
    await app().run(dispatchGate(app().configuration, work));
    await app().run(
      app()
        .pg`UPDATE otp_router.delivery_attempts SET committed_at = LEAST(committed_at,clock_timestamp() - interval '2 seconds'), recovery_at = clock_timestamp() - interval '1 second' WHERE id = ${work.attemptId}`,
    );
    await app().run(recoverDispatches(app().configuration));
    await app().run(dispatch(app().configuration, work));
    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(await Effect.runPromise(app().history.attempt("alpha", work.attemptId))).toMatchObject({
      state: "uncertain",
      invocation: "committed",
      authorization: { state: "approved" },
    });
  });

  it("invalidates an older approval when another attempt receives a project-wide denial", async () => {
    await create();
    const approved = await job();
    await app().run(authorizeAttempt(app().configuration, approved));
    await create("alpha", "+998901234568");
    mode = "deny";
    await app().run(dispatch(app().configuration, await job()));
    await app().run(
      app()
        .pg`UPDATE otp_router.project_send_blocks SET blocked_until = clock_timestamp() - interval '1 second' WHERE project_id = 'alpha'`,
    );
    await app().run(dispatch(app().configuration, approved));
    expect(sent).toHaveLength(0);
    expect(
      await Effect.runPromise(app().history.attempt("alpha", approved.attemptId)),
    ).toMatchObject({ invocation: "not_invoked", diagnosticCode: "approval_unused" });
  });

  it("keeps the original managed code verifiable while authorization is unavailable", async () => {
    const { expiresAt: _expiresAt, code: _code, ...managed } = input();
    const created = await Effect.runPromise(app().router.create(request("alpha", managed)));
    await app().run(dispatch(app().configuration, await job()));
    const original = sent[0];
    if (original === undefined) throw new Error("Expected initial send");
    // Foreign mutations must not reach binding, verification, or terminal transitions.
    expect(
      await Effect.runPromise(
        app()
          .router.verify({
            ...request("beta", {
              code: original.code,
              purpose: "login",
              contextId: "private-binding",
            }),
            challengeId: created.body.challengeId,
          })
          .pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "challenge_not_found" } });
    expect(
      await Effect.runPromise(
        app()
          .router.cancel({
            ...request("beta", {}),
            challengeId: created.body.challengeId,
          })
          .pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "challenge_not_found" } });
    await ageAdmission(app());
    await app().run(
      app()
        .pg`UPDATE otp_router.delivery_operations SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id = ${created.body.operationId}`,
    );
    mode = "unavailable";
    await Effect.runPromise(
      app().router.deliver({
        ...request("alpha", { action: "resend" as const }),
        challengeId: created.body.challengeId,
      }),
    );
    await app().run(dispatch(app().configuration, await job()));
    const verified = await Effect.runPromise(
      app().router.verify({
        ...request("alpha", {
          code: original.code,
          purpose: "login",
          contextId: "private-binding",
        }),
        challengeId: created.body.challengeId,
      }),
    );
    expect(verified.outcome).toBe("completed");
    expect(sent).toHaveLength(1);
    expect(
      (await Effect.runPromise(app().router.status("alpha", created.body.challengeId))).body
        .expiresAt,
    ).toBe(created.body.expiresAt);
  });
});

it("retains acceptance and later failure evidence, including after terminal state, with complete feed pagination", async () => {
  const created = await create();
  const work = await job();
  await app().run(dispatch(app().configuration, work));
  await Effect.runPromise(
    app().delivery.close({ ...request("alpha", {}), operationId: created.body.operationId }),
  );
  const terminal = (
    await Effect.runPromise(app().delivery.status("alpha", created.body.operationId))
  ).body;
  const callback = {
    deduplicationKey: "late-failure",
    correlationReference: {
      _tag: "ProviderRequest" as const,
      providerRequestId: `fake:${work.attemptId}`,
    },
    status: "failed" as const,
  };
  await app().run(ingestEvents(app().configuration, "primary", [callback]));
  const failed = await Effect.runPromise(app().history.attempt("alpha", work.attemptId));
  expect(failed).toMatchObject({ state: "failed", acceptance: "accepted" });
  const full = await Effect.runPromise(app().history.events("alpha", {}));
  const oldCursor = (await Effect.runPromise(app().history.events("alpha", { limit: 1 })))
    .nextCursor;
  await app().run(ingestEvents(app().configuration, "primary", [callback]));
  expect(
    (await Effect.runPromise(app().history.events("alpha", { cursor: full.nextCursor }))).events,
  ).toHaveLength(0);
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await Effect.runPromise(
      app().history.events("alpha", { limit: 2, ...(cursor === undefined ? {} : { cursor }) }),
    );
    ids.push(...page.events.map((event) => event.eventId));
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  expect(ids).toEqual(full.events.map((event) => event.eventId));
  const evidence = full.events.filter((event) => event.type === "attempt.evidence");
  expect(evidence.map((event) => event.evidence.state)).toEqual(["accepted", "failed"]);
  const current = (
    await Effect.runPromise(app().delivery.status("alpha", created.body.operationId))
  ).body;
  expect(current.revision).toBe(terminal.revision);
  expect(current.state).toBe("closed");
  const serialized = JSON.stringify(full);
  for (const secret of ["001234", "+998901234567", "private-binding"])
    expect(serialized).not.toContain(secret);
  expect(
    await app().run(
      rows(
        Schema.Struct({ operation_id: Schema.String }),
        app()
          .pg`SELECT operation_id FROM otp_router.delivery_secrets WHERE operation_id = ${created.body.operationId}`,
      ),
    ),
  ).toHaveLength(0);
  await app().run(
    app()
      .pg`UPDATE otp_router.delivery_operations SET terminal_at = clock_timestamp() - interval '8 days', history_updated_at = clock_timestamp() - interval '8 days' WHERE id = ${created.body.operationId}`,
  );
  await app().run(cleanup(app().configuration));
  expect((await Effect.runPromise(app().history.attempt("alpha", work.attemptId))).acceptance).toBe(
    "accepted",
  );
  await app().run(
    app()
      .pg`UPDATE otp_router.delivery_operations SET terminal_at = clock_timestamp() - interval '31 days', history_updated_at = clock_timestamp() - interval '31 days' WHERE id = ${created.body.operationId}`,
  );
  await app().run(
    app()
      .pg`UPDATE otp_router.events SET occurred_at = clock_timestamp() - interval '31 days' WHERE operation_id = ${created.body.operationId}`,
  );
  await app().run(cleanup(app().configuration));
  expect(
    await Effect.runPromise(
      app().history.events("alpha", { cursor: oldCursor }).pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "history_cursor_expired" } });
  expect(
    await Effect.runPromise(app().history.attempt("alpha", work.attemptId).pipe(Effect.result)),
  ).toMatchObject({ _tag: "Failure", failure: { code: "operation_not_found" } });
});

it("allows only one provider invocation when two workers race authorization", async () => {
  await create();
  const work = await job();
  mode = "blocked";
  const first = app().run(dispatch(app().configuration, work));
  await entered.promise;
  try {
    await app().run(dispatch(app().configuration, work));
  } finally {
    release.resolve();
  }
  await first;
  expect(requests).toHaveLength(1);
  expect(reservations.size).toBe(1);
  expect(sent).toHaveLength(1);
});

it("atomically enforces a project's final send allowance while another project remains eligible", async () => {
  if (database === undefined) throw new Error("Database missing");
  const limited = await startRuntime(database.databaseUrl, {
    ...configuration,
    settings: {
      ...configuration.settings,
      projects: { alpha: { ...project, sendLimit15m: 1 }, beta: project },
    },
  });
  try {
    await Effect.runPromise(limited.delivery.create(request("alpha", input())));
    await Effect.runPromise(limited.delivery.create(request("alpha", input("+998901234568"))));
    const first = await job(),
      second = await job();
    await Promise.all([
      limited.run(dispatch(limited.configuration, first)),
      limited.run(dispatch(limited.configuration, second)),
    ]);
    expect(sent).toHaveLength(1);
    await Effect.runPromise(limited.delivery.create(request("beta", input())));
    await limited.run(dispatch(limited.configuration, await job()));
    expect(sent).toHaveLength(2);
    const usage = await limited.run(
      rows(
        Schema.Struct({ identity: Schema.String, count: Schema.Int }),
        limited.pg`SELECT 'project:' || scope_id AS identity,count(*)::int AS count FROM otp_router.quota_allocations WHERE kind = 'send' AND scope = 'project' AND scope_id IN ('alpha','beta') GROUP BY scope_id ORDER BY scope_id`,
      ),
    );
    expect(usage).toEqual([
      { identity: "project:alpha", count: 1 },
      { identity: "project:beta", count: 1 },
    ]);
  } finally {
    await limited.close();
  }
});

it("keeps operation pagination bounded while new operations are created", async () => {
  const first = await create();
  const second = await create("alpha", "+998901234568");
  const page = await Effect.runPromise(app().history.operations("alpha", { limit: 1 }));
  expect(page.operations.map((operation) => operation.operationId)).toEqual([
    first.body.operationId,
  ]);
  if (page.nextCursor === null) throw new Error("Expected continuation");
  const third = await create("alpha", "+998901234569");
  const next = await Effect.runPromise(
    app().history.operations("alpha", { limit: 1, cursor: page.nextCursor }),
  );
  expect(next.operations.map((operation) => operation.operationId)).toEqual([
    second.body.operationId,
  ]);
  expect(next.nextCursor).toBeNull();
  expect(
    (await Effect.runPromise(app().history.operations("alpha", {}))).operations.map(
      (operation) => operation.operationId,
    ),
  ).toEqual([first.body.operationId, second.body.operationId, third.body.operationId]);
});

it("does not skip evidence whose transaction commits after an intervening feed read", async () => {
  await create();
  const first = await job();
  await app().run(dispatch(app().configuration, first));
  await create("alpha", "+998901234568");
  const second = await job();
  await app().run(dispatch(app().configuration, second));
  const start = await Effect.runPromise(app().history.events("alpha", {}));
  const held = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const delayed = app().run(
    deliveryTransaction(
      app().configuration,
      Effect.gen(function* () {
        yield* recordOutcome(app().configuration, first.attemptId, {
          state: "delivered",
          acceptance: "accepted",
        });
        held.resolve();
        yield* Effect.promise(() => finish.promise);
      }),
    ),
  );
  await held.promise;
  let cursor = start.nextCursor;
  try {
    await app().run(
      recordOutcome(app().configuration, second.attemptId, {
        state: "delivered",
        acceptance: "accepted",
      }),
    );
    const intervening = await Effect.runPromise(app().history.events("alpha", { cursor }));
    expect(
      intervening.events
        .filter((event) => event.type === "attempt.evidence")
        .map((event) => event.attemptId),
    ).toEqual([second.attemptId]);
    cursor = intervening.nextCursor;
  } finally {
    finish.resolve();
    await delayed;
  }
  const later = await Effect.runPromise(app().history.events("alpha", { cursor }));
  expect(
    later.events
      .filter((event) => event.type === "attempt.evidence")
      .map((event) => event.attemptId),
  ).toEqual([first.attemptId]);
});

it("paginates retained operations and attempts after unrelated event cleanup", async () => {
  const first = await create();
  await ageAdmission(app());
  await app().run(
    app()
      .pg`UPDATE otp_router.delivery_operations SET next_user_send_at = clock_timestamp() WHERE id = ${first.body.operationId}`,
  );
  await Effect.runPromise(
    app().delivery.deliver({
      ...request("alpha", { action: "resend" as const }),
      operationId: first.body.operationId,
    }),
  );
  const second = await create("alpha", "+998901234568");
  const removed = await create("alpha", "+998901234569");
  await Effect.runPromise(
    app().delivery.close({ ...request("alpha", {}), operationId: removed.body.operationId }),
  );
  await app().run(
    app()
      .pg`UPDATE otp_router.delivery_operations SET terminal_at = clock_timestamp() - interval '31 days', history_updated_at = clock_timestamp() - interval '31 days' WHERE id = ${removed.body.operationId}`,
  );
  await app().run(
    app()
      .pg`UPDATE otp_router.events SET occurred_at = clock_timestamp() - interval '31 days' WHERE operation_id = ${removed.body.operationId}`,
  );
  await app().run(cleanup(app().configuration));
  const page = await Effect.runPromise(app().history.operations("alpha", { limit: 1 }));
  expect(page.operations[0]?.operationId).toBe(first.body.operationId);
  if (page.nextCursor === null) throw new Error("Expected continuation");
  const next = await Effect.runPromise(
    app().history.operations("alpha", { limit: 1, cursor: page.nextCursor }),
  );
  expect(next.operations.map((operation) => operation.operationId)).toEqual([
    second.body.operationId,
  ]);
  expect(next.nextCursor).toBeNull();
  const attempts = await Effect.runPromise(
    app().history.attempts("alpha", first.body.operationId, { limit: 1 }),
  );
  expect(attempts.attempts[0]).toMatchObject({
    reason: "initial",
    state: "suppressed",
    invocation: "not_invoked",
  });
  if (attempts.nextCursor === null) throw new Error("Expected attempt continuation");
  const later = await Effect.runPromise(
    app().history.attempts("alpha", first.body.operationId, {
      limit: 1,
      cursor: attempts.nextCursor,
    }),
  );
  expect(later.attempts[0]).toMatchObject({ reason: "resend", state: "pending" });
  expect(later.nextCursor).toBeNull();
});

it("ignores duplicate authorization wakeups until the dispatch recovery deadline", async () => {
  await create();
  const work = await job();
  await app().run(authorizeAttempt(app().configuration, work));
  expect(await app().run(dispatchGate(app().configuration, work))).toBeDefined();
  const before = await Effect.runPromise(app().history.attempt("alpha", work.attemptId));
  expect(before.state).toBe("dispatching");
  await app().run(dispatch(app().configuration, work));
  expect(await Effect.runPromise(app().history.attempt("alpha", work.attemptId))).toEqual(before);
  expect(sent).toHaveLength(0);
  await app().run(
    app()
      .pg`UPDATE otp_router.delivery_attempts SET committed_at = LEAST(committed_at,clock_timestamp() - interval '2 seconds'), recovery_at = clock_timestamp() - interval '1 second' WHERE id = ${work.attemptId}`,
  );
  await app().run(dispatch(app().configuration, work));
  expect(await Effect.runPromise(app().history.attempt("alpha", work.attemptId))).toMatchObject({
    state: "uncertain",
    invocation: "committed",
    diagnosticCode: "worker_recovery",
  });
  expect(sent).toHaveLength(0);
});

it("replays project-scoped external receipts after shorter history retention", async () => {
  const created = await create();
  const closeRequest = { ...request("alpha", {}), operationId: created.body.operationId };
  const original = await Effect.runPromise(app().delivery.close(closeRequest));
  await app().run(
    app()
      .pg`UPDATE otp_router.delivery_operations SET terminal_at = clock_timestamp() - interval '2 days', history_updated_at = clock_timestamp() - interval '2 days' WHERE id = ${created.body.operationId}`,
  );
  await app().run(
    cleanup({
      ...app().configuration,
      settings: { ...app().configuration.settings, historyRetentionDays: 1 },
    }),
  );
  expect(
    await Effect.runPromise(
      app().delivery.status("alpha", created.body.operationId).pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "operation_not_found" } });
  expect(await Effect.runPromise(app().delivery.close(closeRequest))).toEqual({
    ...original,
    replayed: true,
  });
  expect(
    await Effect.runPromise(
      app()
        .delivery.close({ ...closeRequest, projectId: "beta" })
        .pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "operation_not_found" } });
  expect(
    await Effect.runPromise(
      app()
        .delivery.close({ ...closeRequest, key: randomUUID() })
        .pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { code: "operation_not_found" } });
  expect(sent).toHaveLength(0);
});

it("keeps authorization lease retries out of public revisions and history retention", async () => {
  const created = await create();
  const work = await job();
  mode = "unavailable";
  await app().run(dispatch(app().configuration, work));
  const before = await Effect.runPromise(app().history.attempt("alpha", work.attemptId));
  const feed = await Effect.runPromise(app().history.events("alpha", {}));
  const updated = () =>
    app().run(
      rows(
        Schema.Struct({ history_updated_at: Schema.Date }),
        app()
          .pg`SELECT history_updated_at FROM otp_router.delivery_operations WHERE id = ${created.body.operationId}`,
      ),
    );
  const retainedAt = await updated();
  await makeRetryDue(work.attemptId);
  await app().run(dispatch(app().configuration, work));
  expect(requests).toHaveLength(2);
  expect(sent).toHaveLength(0);
  expect(await Effect.runPromise(app().history.attempt("alpha", work.attemptId))).toEqual(before);
  expect(
    (await Effect.runPromise(app().history.events("alpha", { cursor: feed.nextCursor }))).events,
  ).toEqual([]);
  expect(await updated()).toEqual(retainedAt);
});

it("orders operation listings by committed creation rather than transaction start", async () => {
  const held = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const delayed = app().run(
    deliveryTransaction(
      app().configuration,
      Effect.gen(function* () {
        const created = yield* app().delivery.create(request("alpha", input()));
        held.resolve();
        yield* Effect.promise(() => finish.promise);
        return created;
      }),
    ),
  );
  await held.promise;
  let committedId: string;
  try {
    committedId = (await create("alpha", "+998901234568")).body.operationId;
    const page = await Effect.runPromise(app().history.operations("alpha", {}));
    expect(page.operations.map((operation) => operation.operationId)).toEqual([committedId]);
  } finally {
    finish.resolve();
    await delayed;
  }
  const later = await delayed;
  const first = await Effect.runPromise(app().history.operations("alpha", { limit: 1 }));
  expect(first.operations.map((operation) => operation.operationId)).toEqual([committedId]);
  if (first.nextCursor === null) throw new Error("Expected continuation");
  const next = await Effect.runPromise(
    app().history.operations("alpha", { cursor: first.nextCursor }),
  );
  expect(next.operations.map((operation) => operation.operationId)).toEqual([
    later.body.operationId,
  ]);
  expect(next.nextCursor).toBeNull();
});

it("rejects attempts, current pointers, and correlations outside their saved route", async () => {
  const first = await create("alpha");
  const firstJob = await job();
  const second = await create("beta");
  const secondJob = await job();
  const h = app();
  const reject = async (mutation: Effect.Effect<ReadonlyArray<unknown>, SqlError>) => {
    expect(
      await h.run(
        h.pg
          .withTransaction(mutation.pipe(Effect.andThen(h.pg`SET CONSTRAINTS ALL IMMEDIATE`)))
          .pipe(Effect.result),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SqlError", reason: { _tag: "ConstraintError" } },
    });
  };
  await reject(
    h.pg`UPDATE otp_router.delivery_operations SET current_attempt_id = ${secondJob.attemptId} WHERE id = ${first.body.operationId}`,
  );
  await reject(
    h.pg`UPDATE otp_router.delivery_operations SET initial_position = 99 WHERE id = ${first.body.operationId}`,
  );
  await reject(
    h.pg`UPDATE otp_router.delivery_attempts SET route_position = 1 WHERE id = ${firstJob.attemptId}`,
  );
  await reject(
    h.pg`UPDATE otp_router.operation_route_steps SET provider_instance_id = 'replacement' WHERE operation_id = ${first.body.operationId} AND position = 0`,
  );
  await reject(
    h.pg`INSERT INTO otp_router.provider_correlations(provider_instance_id,reference,attempt_id) VALUES ('secondary','wrong-provider',${firstJob.attemptId})`,
  );
  await reject(
    h.pg`UPDATE otp_router.delivery_attempts SET authorization_state = 'approved' WHERE id = ${firstJob.attemptId}`,
  );
  await reject(
    h.pg`UPDATE otp_router.delivery_attempts SET state = 'dispatching' WHERE id = ${firstJob.attemptId}`,
  );
  await h.run(dispatch(h.configuration, firstJob));
  await h.run(dispatch(h.configuration, secondJob));
  expect(sent.map((entry) => entry.operationId)).toEqual([
    first.body.operationId,
    second.body.operationId,
  ]);
  expect(
    (await Effect.runPromise(h.history.attempt("alpha", firstJob.attemptId))).providerInstanceId,
  ).toBe("primary");
});

it("retains scoped send usage after history deletion and releases it only after its rolling window", async () => {
  if (database === undefined) throw new Error("Database missing");
  const h = await startRuntime(database.databaseUrl, {
    ...configuration,
    settings: {
      ...configuration.settings,
      projects: { alpha: { ...project, sendLimit15m: 1, sendLimit24h: 1 }, beta: project },
    },
  });
  try {
    const created = await Effect.runPromise(h.delivery.create(request("alpha", input())));
    const work = await job();
    await h.run(dispatch(h.configuration, work));
    await Effect.runPromise(
      h.delivery.close({ ...request("alpha", {}), operationId: created.body.operationId }),
    );
    await h.run(
      h.pg`UPDATE otp_router.delivery_operations SET terminal_at = clock_timestamp() - interval '31 days', history_updated_at = clock_timestamp() - interval '31 days' WHERE id = ${created.body.operationId}`,
    );
    await h.run(cleanup(h.configuration));
    expect(
      await Effect.runPromise(h.history.attempt("alpha", work.attemptId).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "operation_not_found" } });
    expect(
      await h.run(
        rows(
          Schema.Struct({ facts: Schema.Int, allocations: Schema.Int }),
          h.pg`
      SELECT (SELECT count(*)::int FROM otp_router.quota_events WHERE event_id = ${work.attemptId} AND kind = 'send') AS facts,
        (SELECT count(*)::int FROM otp_router.quota_allocations WHERE event_id = ${work.attemptId} AND kind = 'send') AS allocations`,
        ),
      ),
    ).toEqual([{ facts: 1, allocations: 3 }]);
    await Effect.runPromise(h.delivery.create(request("alpha", input("+998901234568"))));
    const blocked = await job();
    await h.run(dispatch(h.configuration, blocked));
    expect(sent).toHaveLength(1);
    expect(await Effect.runPromise(h.history.attempt("alpha", blocked.attemptId))).toMatchObject({
      state: "suppressed",
      invocation: "not_invoked",
      diagnosticCode: "rate_limited",
    });
    await h.run(
      h.pg`UPDATE otp_router.quota_events SET occurred_at = clock_timestamp() - interval '24 hours 1 second' WHERE event_id = ${work.attemptId} AND kind = 'send'`,
    );
    await h.run(cleanup(h.configuration));
    expect(
      await h.run(
        rows(
          Schema.Struct({ count: Schema.Int }),
          h.pg`SELECT count(*)::int AS count FROM otp_router.quota_allocations WHERE event_id = ${work.attemptId} AND kind = 'send'`,
        ),
      ),
    ).toEqual([{ count: 0 }]);
    await Effect.runPromise(h.delivery.create(request("alpha", input("+998901234569"))));
    await h.run(dispatch(h.configuration, await job()));
    expect(sent).toHaveLength(2);
  } finally {
    await h.close();
  }
});
