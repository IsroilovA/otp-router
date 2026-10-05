import type { FixtureConfiguration as Configuration } from "./fixture.js";
import { NodeServices } from "@effect/platform-node";
import { randomUUID } from "node:crypto";
import { Effect, Layer, Schema } from "effect";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { type AdminCommand } from "@otp-router/engine/projects";
import { SendAuthorizer } from "@otp-router/engine/delivery";
import {
  FakeProvider,
  ProviderInstance,
  ProviderInstanceIdSchema,
  ProviderRejected,
  type ProviderSendInput,
} from "@otp-router/engine/providers";
import {
  startPostgres,
  startRuntime,
  ageAdmission,
  type PostgresFixture,
  type IntegrationRuntime,
} from "./fixture.js";
import { rows } from "../packages/engine/src/database/query.js";
import { migrate } from "../packages/engine/src/database/migrations.js";
import { dispatch } from "../packages/engine/src/delivery/dispatch.js";
import { DeliveryJob, deliveryQueue } from "../packages/engine/src/queue/contracts.js";
import { cleanupAdminReceipts } from "../packages/engine/src/projects/retention.js";

let block: "none" | "selector" | "authorizer" | "provider" = "none";
let reject = false;
let entered = Promise.withResolvers<void>();
let release = Promise.withResolvers<void>();
const sent: ProviderSendInput[] = [];
const barrier = (stage: typeof block) =>
  Effect.gen(function* () {
    if (block !== stage) return;
    entered.resolve();
    yield* Effect.promise(() => release.promise);
  });
const provider = (id: string) =>
  Layer.effect(
    ProviderInstance,
    Effect.gen(function* () {
      const original = yield* ProviderInstance;
      return {
        ...original,
        send: (input: ProviderSendInput) =>
          Effect.gen(function* () {
            sent.push(input);
            yield* barrier("provider");
            if (reject)
              return yield* Effect.fail(
                new ProviderRejected({
                  reason: "recipient_unavailable",
                  diagnosticCode: "unclassified",
                }),
              );
            return yield* original.send(input);
          }),
      };
    }),
  ).pipe(
    Layer.provide(
      FakeProvider.make({
        instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)(id),
        revision: "administration",
        identity: { account: "fixture" },
        secrets: {},
        execution: { outcome: "accepted" },
        templates: {},
      }),
    ),
  );
const ring = (n: number) => ({
  active: "a",
  keys: { a: Buffer.alloc(32, n).toString("base64url") },
});
const configuration: Configuration = {
  settings: {
    crypto: {
      deploymentId: "administration",
      encryption: ring(1),
      verification: ring(2),
      fingerprint: ring(3),
      recipientKey: Buffer.alloc(32, 4).toString("base64url"),
    },
    administration: {
      principalIds: ["backend", "alternate"],
      authorizationFloor: true,
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
          projectIds: ["demo", "alpha", "beta"],
          creationPrefixes: ["alpha_"],
          grantablePrincipalIds: ["backend", "alternate"],
          editableSettings: ["authorizationRequired", "sendLimit15m", "sendLimit24h"],
          sendLimit15mCeiling: 100000,
          sendLimit24hCeiling: 100000,
          mayDisableAuthorization: true,
        },
        limited: {
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
          actions: ["create", "read", "list", "update", "grant", "revoke", "audit"],
          projectIds: [],
          creationPrefixes: ["alpha_"],
          grantablePrincipalIds: ["backend"],
          editableSettings: ["sendLimit15m"],
          sendLimit15mCeiling: 20,
          sendLimit24hCeiling: 100,
          mayDisableAuthorization: false,
        },
      },
    },
    deploymentSendLimit15m: 10000,
    deploymentSendLimit24h: 100000,
  },
  fixtures: {
    defaultLocale: "en",
    fallbackLocales: [],
    policies: {
      login: {
        providerInstanceIds: ["first", "second"],
        manualSelectionEnabled: true,
        managed: {},
      },
    },
    purposes: { login: ["login"] },
  },
  providerFixtures: [provider("first"), provider("second")],
  selectors: {
    login: () =>
      barrier("selector").pipe(
        Effect.as({ _tag: "Route" as const, providerInstanceIds: ["first", "second"] }),
      ),
  },
  authorizer: Layer.succeed(SendAuthorizer, {
    reserve: (request) =>
      barrier("authorizer").pipe(
        Effect.as({
          deploymentId: request.deploymentId,
          projectId: request.projectId,
          attemptId: request.attemptId,
          decision: "approved" as const,
          reservationId: request.attemptId,
          validUntil: request.dispatchDeadline,
        }),
      ),
  }),
};
let database: PostgresFixture | undefined;
let runtime: IntegrationRuntime | undefined;
const app = () => {
  if (runtime === undefined) throw new Error("Missing runtime");
  return runtime;
};
const db = () => {
  if (database === undefined) throw new Error("Missing database");
  return database;
};
const settings = { authorizationRequired: true, sendLimit15m: 10, sendLimit24h: 100 };
const administer = (command: typeof AdminCommand.Type, key = randomUUID(), actorId = "admin") =>
  Effect.runPromise(app().projects.mutate({ actorId, key, command }));
const createProject = (id = "alpha_new", key = randomUUID()) =>
  administer(
    { action: "create", input: { id, settings, principalIds: ["backend", "alternate"] } },
    key,
  );
const command = <A>(input: A, projectId = "alpha", principalId = "backend") => ({
  projectId,
  principalId,
  key: randomUUID(),
  requestId: randomUUID(),
  input,
});
const deliveryInput = () => ({
  recipient: { type: "phone" as const, phoneNumber: "+998901234567" },
  policyId: "login",
  purpose: "login",
  contextId: "private",
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  code: "123456",
});
const preparationInput = () => {
  const { code: _code, ...input } = deliveryInput();
  return input;
};
const createDelivery = () => Effect.runPromise(app().delivery.create(command(deliveryInput())));
const job = async () => {
  const entry = (await app().queue.fetch(deliveryQueue))[0];
  if (entry === undefined) throw new Error("Missing job");
  return Schema.decodeUnknownSync(DeliveryJob)(entry.data);
};
const transition = async (action: "suspend" | "reactivate" | "retire" | "grant" | "revoke") => {
  const current = await Effect.runPromise(app().projects.get("admin", "alpha"));
  return administer(
    action === "grant" || action === "revoke"
      ? { action, projectId: "alpha", expectedRevision: current.revision, principalId: "backend" }
      : { action, projectId: "alpha", expectedRevision: current.revision },
  );
};
const grantRuntime = async (projectId: string) => {
  for (const [kind, id] of [
    ["policy", "login"],
    ["instance", "first"],
    ["instance", "second"],
  ] as const) {
    const before = await Effect.runPromise(app().runtime.get("admin", kind, id));
    await Effect.runPromise(
      app().runtime.mutate({
        actorId: "admin",
        key: randomUUID(),
        command: { action: "grant", kind, id, projectId, expectedRevision: before.revision },
      }),
    );
  }
};
beforeAll(async () => {
  database = await startPostgres();
  runtime = await startRuntime(database.databaseUrl, configuration);
}, 30000);
beforeEach(async () => {
  await app().reset();
  block = "none";
  reject = false;
  sent.length = 0;
  entered = Promise.withResolvers<void>();
  release = Promise.withResolvers<void>();
});
afterAll(async () => {
  release.resolve();
  await runtime?.close();
  await database?.close();
});

it("atomically creates settings, grants, one audit event and permanent replay under concurrent requests", async () => {
  const key = randomUUID();
  const responses = await Promise.all([
    createProject("alpha_new", key),
    createProject("alpha_new", key),
  ]);
  expect(responses.map((r) => r.replayed).sort((a, b) => Number(a) - Number(b))).toEqual([
    false,
    true,
  ]);
  expect(responses[0].body).toEqual(responses[1].body);
  const created = responses[0];
  expect(created.body.grants.map((g) => g.principalId)).toEqual(["alternate", "backend"]);
  await expect(
    administer(
      { action: "create", input: { id: "alpha_conflict", settings, principalIds: ["backend"] } },
      key,
    ),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  const change = { action: "suspend" as const, projectId: "alpha_new", expectedRevision: 1 };
  const updateKey = randomUUID();
  const updated = await administer(change, updateKey);
  expect(await administer(change, updateKey)).toEqual({ ...updated, replayed: true });
  await expect(administer(change)).rejects.toMatchObject({ code: "revision_conflict" });
  expect((await createProject("alpha_new", key)).body.state).toBe("active");
  const page = await Effect.runPromise(app().projects.audit("admin", "alpha_new", { limit: 1 }));
  expect(page.events.map((e) => [e.action, e.revision])).toEqual([["create", 1]]);
  expect(page.nextCursor).not.toBeNull();
  const rest = await Effect.runPromise(
    app().projects.audit("admin", "alpha_new", { cursor: page.nextCursor ?? "", limit: 1 }),
  );
  expect(rest.events.map((e) => [e.action, e.revision])).toEqual([["suspend", 2]]);
  await administer({ action: "retire", projectId: "alpha_new", expectedRevision: 2 });
  await expect(
    administer({ action: "reactivate", projectId: "alpha_new", expectedRevision: 3 }),
  ).rejects.toMatchObject({ code: "project_conflict" });
  await expect(createProject()).rejects.toMatchObject({ code: "project_conflict" });
  await app().run(
    app()
      .pg`UPDATE otp_router.admin_request_receipts SET created_at = clock_timestamp()-interval '9 days', retain_until = clock_timestamp()-interval '1 day' WHERE project_id = 'alpha_new' AND retain_until IS NOT NULL`,
  );
  expect(await app().run(cleanupAdminReceipts)).toBe(2);
  expect((await createProject("alpha_new", key)).replayed).toBe(true);
  expect(
    (await Effect.runPromise(app().projects.audit("admin", "alpha_new", {}))).events,
  ).toHaveLength(3);
});

it("rolls back project, initial grants and receipt when audit persistence fails", async () => {
  const sql = app().pg;
  await app().run(
    sql`CREATE FUNCTION otp_router.fail_admin_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$`,
  );
  await app().run(
    sql`CREATE TRIGGER fail_admin_audit BEFORE INSERT ON otp_router.project_admin_events FOR EACH ROW EXECUTE FUNCTION otp_router.fail_admin_audit()`,
  );
  const key = randomUUID();
  try {
    await expect(createProject("alpha_rollback", key)).rejects.toMatchObject({
      code: "temporarily_unavailable",
    });
  } finally {
    await app().run(sql`DROP TRIGGER fail_admin_audit ON otp_router.project_admin_events`);
    await app().run(sql`DROP FUNCTION otp_router.fail_admin_audit()`);
  }
  expect(
    await app().run(
      rows(
        Schema.Struct({ count: Schema.Int }),
        sql`SELECT count(*)::int AS count FROM otp_router.projects WHERE id = 'alpha_rollback'`,
      ),
    ),
  ).toEqual([{ count: 0 }]);
  expect((await createProject("alpha_rollback", key)).replayed).toBe(false);
});

it("enforces literal scopes, actions, editable fields, principal ceilings and the authorization floor", async () => {
  await createProject();
  const denied = (value: typeof AdminCommand.Type) =>
    expect(administer(value, randomUUID(), "limited")).rejects.toMatchObject({
      code: "admin_forbidden",
    });
  await denied({
    action: "create",
    input: { id: "alphaXescape", settings, principalIds: ["backend"] },
  });
  await denied({
    action: "create",
    input: { id: "alpha_missing_fields", settings, principalIds: ["backend"] },
  });
  await denied({
    action: "update",
    projectId: "alpha_new",
    expectedRevision: 1,
    settings: { ...settings, sendLimit24h: 90 },
  });
  await denied({
    action: "update",
    projectId: "alpha_new",
    expectedRevision: 1,
    settings: { ...settings, sendLimit15m: 21 },
  });
  await denied({
    action: "revoke",
    projectId: "alpha_new",
    expectedRevision: 1,
    principalId: "alternate",
  });
  await denied({ action: "suspend", projectId: "alpha_new", expectedRevision: 1 });
  await expect(
    administer({
      action: "update",
      projectId: "alpha_new",
      expectedRevision: 1,
      settings: { ...settings, authorizationRequired: false },
    }),
  ).rejects.toMatchObject({ code: "admin_forbidden" });
  await expect(
    administer({
      action: "grant",
      projectId: "alpha_new",
      expectedRevision: 1,
      principalId: "unconfigured",
    }),
  ).rejects.toMatchObject({ code: "admin_forbidden" });
  const permitted = await administer(
    {
      action: "update",
      projectId: "alpha_new",
      expectedRevision: 1,
      settings: { ...settings, sendLimit15m: 11 },
    },
    randomUUID(),
    "limited",
  );
  expect(permitted.body.revision).toBe(2);
  const page = await Effect.runPromise(app().projects.list("limited", { limit: 1 }));
  expect(page.projects.map((p) => p.id)).toEqual(["alpha_new"]);
  await expect(Effect.runPromise(app().projects.get("limited", "alpha"))).rejects.toMatchObject({
    code: "admin_forbidden",
  });
});

it("serializes conflicting revisions and makes activation and revocation visible to another instance", async () => {
  const other = await startRuntime(db().databaseUrl, configuration);
  try {
    await createProject();
    await grantRuntime("alpha_new");
    const access = await Effect.runPromise(
      other.delivery.prepare(command(preparationInput(), "alpha_new")),
    );
    expect(access.body.projectId).toBe("alpha_new");
    const commands = ["suspend", "retire"] as const;
    const results = await Promise.all(
      commands.map((action) =>
        Effect.runPromise(
          app()
            .projects.mutate({
              actorId: "admin",
              key: randomUUID(),
              command: { action, projectId: "alpha_new", expectedRevision: 1 },
            })
            .pipe(Effect.result),
        ),
      ),
    );
    expect(results.map((r) => r._tag).sort()).toEqual(["Failure", "Success"]);
    expect((await Effect.runPromise(other.projects.get("admin", "alpha_new"))).revision).toBe(2);
    await transition("revoke");
    await expect(
      Effect.runPromise(other.delivery.prepare(command(preparationInput()))),
    ).rejects.toMatchObject({ code: "project_access_denied" });
  } finally {
    await other.close();
  }
});

it.each(["suspend", "revoke"] as const)(
  "revalidates authority after selection during %s",
  async (action) => {
    block = "selector";
    const pending = Effect.runPromise(
      app().delivery.create(command(deliveryInput())).pipe(Effect.result),
    );
    await entered.promise;
    try {
      await transition(action);
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({
      _tag: "Failure",
      failure: { code: action === "suspend" ? "project_inactive" : "project_access_denied" },
    });
    expect(
      await app().run(
        rows(
          Schema.Struct({ count: Schema.Int }),
          app().pg`SELECT count(*)::int AS count FROM otp_router.delivery_operations`,
        ),
      ),
    ).toEqual([{ count: 0 }]);
  },
);

it.each(["suspend", "revoke"] as const)(
  "records late approval as unused after %s and never revives its intent",
  async (action) => {
    await createDelivery();
    const work = await job();
    block = "authorizer";
    const pending = app().run(dispatch(app().configuration, work));
    await entered.promise;
    try {
      await transition(action);
      await transition(action === "suspend" ? "reactivate" : "grant");
      // A duplicate worker suppresses the invalidated intent before the approval returns.
      await app().run(dispatch(app().configuration, work));
    } finally {
      release.resolve();
    }
    await pending;
    await app().run(dispatch(app().configuration, work));
    expect(sent).toHaveLength(0);
    expect(
      await Effect.runPromise(app().history.attempt("alpha", work.attemptId, "backend")),
    ).toMatchObject({
      state: "suppressed",
      invocation: "not_invoked",
      authorization: { state: "approved" },
      diagnosticCode: "approval_unused",
    });
  },
);

it("lets a committed provider call finish after suspension but blocks its late failed fallback", async () => {
  await createDelivery();
  const work = await job();
  block = "provider";
  reject = true;
  const pending = app().run(dispatch(app().configuration, work));
  await entered.promise;
  try {
    await transition("suspend");
    await transition("reactivate");
  } finally {
    release.resolve();
  }
  await pending;
  expect(sent).toHaveLength(1);
  expect(
    await Effect.runPromise(app().history.attempt("alpha", work.attemptId, "backend")),
  ).toMatchObject({ state: "failed", invocation: "committed" });
  expect(await app().queue.fetch(deliveryQueue)).toHaveLength(0);
});

it("inherits fallback authority, keeps preparation intent-free and admits a new intent under the attaching grant", async () => {
  await createProject();
  await grantRuntime("alpha_new");
  const prepared = await Effect.runPromise(
    app().delivery.prepare(command(preparationInput(), "alpha_new")),
  );
  expect(
    await app().run(
      rows(
        Schema.Struct({ count: Schema.Int }),
        app().pg`SELECT count(*)::int AS count FROM otp_router.send_intents`,
      ),
    ),
  ).toEqual([{ count: 0 }]);
  await Effect.runPromise(
    app().delivery.submitCode({
      ...command({ code: "001234" }, "alpha_new", "alternate"),
      operationId: prepared.body.operationId,
    }),
  );
  reject = true;
  await app().run(dispatch(app().configuration, await job()));
  const fallback = await job();
  const facts = await app().run(
    rows(
      Schema.Struct({ principal_id: Schema.String, count: Schema.Int }),
      app()
        .pg`SELECT g.principal_id,count(a.id)::int AS count FROM otp_router.send_intents i JOIN otp_router.project_principal_grants g ON g.id = i.principal_grant_id JOIN otp_router.delivery_attempts a ON a.intent_id = i.id GROUP BY i.id,g.principal_id`,
    ),
  );
  expect(facts).toEqual([{ principal_id: "alternate", count: 2 }]);
  const originalGrant = (
    await Effect.runPromise(app().projects.get("admin", "alpha_new"))
  ).grants.find((g) => g.principalId === "alternate");
  await administer({
    action: "revoke",
    projectId: "alpha_new",
    expectedRevision: 1,
    principalId: "alternate",
  });
  const regrant = await administer({
    action: "grant",
    projectId: "alpha_new",
    expectedRevision: 2,
    principalId: "alternate",
  });
  expect(regrant.body.grants.find((g) => g.principalId === "alternate")?.id).not.toBe(
    originalGrant?.id,
  );
  await app().run(dispatch(app().configuration, fallback));
  expect(sent).toHaveLength(1);
  await ageAdmission(app());
  await app().run(
    app()
      .pg`UPDATE otp_router.delivery_operations SET next_user_send_at = clock_timestamp()-interval '1 second' WHERE id = ${prepared.body.operationId}`,
  );
  reject = false;
  await Effect.runPromise(
    app().delivery.deliver({
      ...command({ action: "resend" as const }, "alpha_new", "backend"),
      operationId: prepared.body.operationId,
    }),
  );
  await app().run(dispatch(app().configuration, await job()));
  expect(sent.map((s) => s.code)).toEqual(["001234", "001234"]);
  expect(sent[1]?.expiresAt).toBe(prepared.body.expiresAt);
});

it("rejects old schema baselines and incompatible live capabilities without changing persisted projects", async () => {
  const before = await Effect.runPromise(app().projects.get("admin", "alpha"));
  const sql = app().pg;
  expect(
    await app().run(
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`ALTER TABLE otp_router.schema_identity RENAME TO old_identity`;
            yield* migrate.pipe(Effect.provide(NodeServices.layer));
          }),
        )
        .pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure", failure: { _tag: "SchemaCompatibilityError" } });
  for (const baseline of [
    "project-administration-integration-reference-v1",
    "runtime-configuration-v1",
    "runtime-configuration-v2",
  ])
    expect(
      await app().run(
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE otp_router.schema_identity SET baseline = ${baseline} WHERE singleton`;
              yield* migrate.pipe(Effect.provide(NodeServices.layer));
            }),
          )
          .pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "SchemaCompatibilityError" } });
  for (const settings of [
    { ...configuration.settings, historyRetentionDays: 1 },
    {
      ...configuration.settings,
      webhook: {
        url: "http://127.0.0.1:12345/events",
        signingSecret: `whsec_${Buffer.alloc(32, 5).toString("base64")}`,
      },
    },
  ]) {
    await expect(
      startRuntime(db().databaseUrl, { ...configuration, settings }).then((other) => other.close()),
    ).rejects.toMatchObject({ reason: "incompatible_capabilities" });
  }
  expect(await Effect.runPromise(app().projects.get("admin", "alpha"))).toEqual(before);
  await app().close();
  runtime = await startRuntime(db().databaseUrl, configuration);
  expect(await Effect.runPromise(app().projects.get("admin", "alpha"))).toEqual(before);
});

it.each(["action", "setting"] as const)(
  "checks current administrator %s permissions before replay and preserves grants on restart",
  async (permission) => {
    const created = await createProject();
    const request = {
      actorId: "admin",
      key: randomUUID(),
      command: {
        action: "update" as const,
        projectId: created.body.id,
        expectedRevision: 1,
        settings: { ...settings, sendLimit15m: 12 },
      },
    };
    await Effect.runPromise(app().projects.mutate(request));
    const permissions = configuration.settings.administration.administrators["admin"];
    if (permissions === undefined) throw new Error("Missing administrator");
    await app().close();
    runtime = await startRuntime(db().databaseUrl, {
      ...configuration,
      settings: {
        ...configuration.settings,
        administration: {
          ...configuration.settings.administration,
          administrators: {
            ...configuration.settings.administration.administrators,
            admin: {
              ...permissions,
              ...(permission === "action"
                ? {
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
                    actions: ["create", "read"] as const,
                  }
                : { editableSettings: ["authorizationRequired", "sendLimit24h"] as const }),
            },
          },
        },
      },
    });
    try {
      await expect(Effect.runPromise(app().projects.mutate(request))).rejects.toMatchObject({
        code: "admin_forbidden",
      });
      expect(
        (await Effect.runPromise(app().projects.get("admin", created.body.id))).grants,
      ).toEqual(created.body.grants);
    } finally {
      await app().close();
      runtime = await startRuntime(db().databaseUrl, configuration);
    }
  },
);

it.each(["update", "grant"] as const)(
  "replays a no-op %s without checking an unrelated settings change",
  async (action) => {
    await createProject();
    const changed = await administer({
      action: "update",
      projectId: "alpha_new",
      expectedRevision: 1,
      settings: { ...settings, sendLimit24h: 90 },
    });
    const request: typeof AdminCommand.Type =
      action === "update"
        ? { action, projectId: "alpha_new", expectedRevision: 2, settings: changed.body.settings }
        : { action, projectId: "alpha_new", expectedRevision: 2, principalId: "backend" };
    const key = randomUUID();
    const original = await administer(request, key, "limited");
    expect(original.body).toEqual(changed.body);
    expect(await administer(request, key, "limited")).toEqual({ ...original, replayed: true });
    await administer({
      action: "update",
      projectId: "alpha_new",
      expectedRevision: 2,
      settings: { ...changed.body.settings, sendLimit15m: 12 },
    });
    expect(await administer(request, key, "limited")).toEqual({ ...original, replayed: true });
    expect(
      (await Effect.runPromise(app().projects.audit("admin", "alpha_new", {}))).events.map(
        (event) => [event.action, event.revision],
      ),
    ).toEqual([
      ["create", 1],
      ["update", 2],
      ["update", 3],
    ]);
  },
);

it("allows limit changes on disabled authorization while denying creation and transitions that disable it", async () => {
  const permissions = configuration.settings.administration.administrators["limited"];
  const adminPermissions = configuration.settings.administration.administrators["admin"];
  if (permissions === undefined || adminPermissions === undefined)
    throw new Error("Missing administrator");
  await app().close();
  runtime = await startRuntime(db().databaseUrl, {
    ...configuration,
    settings: {
      ...configuration.settings,
      administration: {
        ...configuration.settings.administration,
        authorizationFloor: false,
        administrators: {
          ...configuration.settings.administration.administrators,
          limited: {
            ...permissions,
            editableSettings: ["authorizationRequired", "sendLimit15m", "sendLimit24h"],
          },
        },
      },
    },
  });
  try {
    await createProject();
    await expect(
      administer(
        {
          action: "create",
          input: {
            id: "alpha_disabled",
            settings: { ...settings, authorizationRequired: false },
            principalIds: ["backend"],
          },
        },
        randomUUID(),
        "limited",
      ),
    ).rejects.toMatchObject({ code: "admin_forbidden" });
    const disable: typeof AdminCommand.Type = {
      action: "update",
      projectId: "alpha_new",
      expectedRevision: 1,
      settings: { ...settings, authorizationRequired: false },
    };
    await expect(administer(disable, randomUUID(), "limited")).rejects.toMatchObject({
      code: "admin_forbidden",
    });
    const disableKey = randomUUID();
    await administer(disable, disableKey);
    const request: typeof AdminCommand.Type = {
      action: "update",
      projectId: "alpha_new",
      expectedRevision: 2,
      settings: { ...settings, authorizationRequired: false, sendLimit15m: 11 },
    };
    const key = randomUUID();
    const original = await administer(request, key, "limited");
    expect(original.body.revision).toBe(3);
    expect(await administer(request, key, "limited")).toEqual({ ...original, replayed: true });
    await app().close();
    runtime = await startRuntime(db().databaseUrl, {
      ...configuration,
      settings: {
        ...configuration.settings,
        administration: {
          ...configuration.settings.administration,
          authorizationFloor: false,
          administrators: {
            ...configuration.settings.administration.administrators,
            admin: { ...adminPermissions, mayDisableAuthorization: false },
          },
        },
      },
    });
    await expect(administer(disable, disableKey)).rejects.toMatchObject({
      code: "admin_forbidden",
    });
  } finally {
    const current = await Effect.runPromise(app().projects.get("admin", "alpha_new"));
    await administer({
      action: "update",
      projectId: "alpha_new",
      expectedRevision: current.revision,
      settings: { ...current.settings, authorizationRequired: true },
    });
    await app().close();
    runtime = await startRuntime(db().databaseUrl, configuration);
  }
});

it("keeps competing creation and no-op receipts distinct from revisioned audit", async () => {
  const requests = [10, 11].map((limit) => ({
    actorId: "admin",
    key: "same-key",
    command: {
      action: "create" as const,
      input: {
        id: "alpha_conflict",
        settings: { ...settings, sendLimit15m: limit },
        principalIds: ["backend"],
      },
    },
  }));
  const results = await Promise.all(
    requests.map((request) =>
      Effect.runPromise(app().projects.mutate(request).pipe(Effect.result)),
    ),
  );
  expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
  expect(results.find((r) => r._tag === "Failure")).toMatchObject({
    failure: { code: "idempotency_conflict" },
  });
  const noop = await administer({
    action: "grant",
    projectId: "alpha_conflict",
    expectedRevision: 1,
    principalId: "backend",
  });
  expect(noop.body.revision).toBe(1);
  expect(
    (await Effect.runPromise(app().projects.audit("admin", "alpha_conflict", {}))).events,
  ).toHaveLength(1);
});

it("enforces same-project intent grants and allows revoking historical access after retirement", async () => {
  const created = await createDelivery();
  const other = await createProject();
  const grant = other.body.grants[0];
  if (grant === undefined) throw new Error("Missing grant");
  const invalid = await app().run(
    app()
      .pg`INSERT INTO otp_router.send_intents(id,operation_id,project_id,principal_grant_id,project_send_epoch,action,authority)
        SELECT ${randomUUID()},operation_id,project_id,${grant.id},project_send_epoch,'resend',authority
        FROM otp_router.send_intents WHERE operation_id = ${created.body.operationId}`.pipe(
      Effect.result,
    ),
  );
  expect(invalid).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "SqlError", reason: { cause: { code: "23503" } } },
  });
  await transition("retire");
  expect(
    (await Effect.runPromise(app().delivery.status("alpha", created.body.operationId, "backend")))
      .body.operationId,
  ).toBe(created.body.operationId);
  await Effect.runPromise(
    app().delivery.close({ ...command({}), operationId: created.body.operationId }),
  );
  await transition("revoke");
  await expect(
    Effect.runPromise(app().delivery.status("alpha", created.body.operationId, "backend")),
  ).rejects.toMatchObject({ code: "project_access_denied" });
});

it("reconciles saved backend receipts during suspension but never replays through a revoked grant", async () => {
  const request = command(deliveryInput());
  const original = await Effect.runPromise(app().delivery.create(request));
  await transition("suspend");
  expect(await Effect.runPromise(app().delivery.create(request))).toEqual({
    ...original,
    replayed: true,
  });
  await expect(
    Effect.runPromise(app().delivery.create({ ...request, key: randomUUID() })),
  ).rejects.toMatchObject({ code: "project_inactive" });
  const managedRequest = command({
    recipient: { type: "phone" as const, phoneNumber: "+998901234568" },
    purpose: "login",
    policyId: "login",
    contextId: "receipt",
  });
  await transition("reactivate");
  const managed = await Effect.runPromise(app().router.create(managedRequest));
  await transition("retire");
  expect(await Effect.runPromise(app().router.create(managedRequest))).toEqual({
    ...managed,
    replayed: true,
  });
  await transition("revoke");
  await expect(Effect.runPromise(app().delivery.create(request))).rejects.toMatchObject({
    code: "project_access_denied",
  });
  await expect(Effect.runPromise(app().router.create(managedRequest))).rejects.toMatchObject({
    code: "project_access_denied",
  });
  expect(
    await app().run(
      rows(
        Schema.Struct({ count: Schema.Int }),
        app().pg`SELECT count(*)::int AS count FROM otp_router.send_intents`,
      ),
    ),
  ).toEqual([{ count: 2 }]);
  expect(sent).toHaveLength(0);
});
