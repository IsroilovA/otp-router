import { randomUUID } from "node:crypto";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { RouterConfig } from "../packages/engine/src/config/runtime.js";
import { validateStoredKeys } from "../packages/engine/src/database/compatibility.js";
import { rows } from "../packages/engine/src/database/query.js";
import { dispatch, dispatchGate } from "../packages/engine/src/delivery/dispatch.js";
import {
  ProviderCallbacks,
  ProviderCallbacksLive,
} from "../packages/engine/src/delivery/provider-callbacks.js";
import { lockQuotas, sendLimits } from "../packages/engine/src/delivery/quotas.js";
import {
  CallbackAuthenticationError,
  CallbackFormatError,
  ProviderInstance,
  ProviderConfigurationError,
  type ProviderDefinition,
  defineProvider,
  FakeProvider,
  ProviderContractVersion,
  ProviderRejected,
  type ProviderSendInput,
  ProviderUncertain,
  signFakeCallback,
} from "../packages/engine/src/providers/index.js";
import { DeliveryJob, deliveryQueue } from "../packages/engine/src/queue/contracts.js";
import {
  type Policy,
  type ResourceKind,
  RuntimeCommand,
} from "../packages/engine/src/runtime/contracts.js";
import { mutateRuntime } from "../packages/engine/src/runtime/mutate.js";
import { constructProvider, secretVersion } from "../packages/engine/src/runtime/providers.js";
import { cleanupRuntimeSecrets } from "../packages/engine/src/runtime/retention.js";
import {
  ageAdmission,
  type FixtureConfiguration,
  type IntegrationRuntime,
  type PostgresFixture,
  startPostgres,
  startRuntime,
} from "./fixture.js";

const invocations: {
  readonly token: string;
  readonly sender: string;
  readonly input: ProviderSendInput;
}[] = [];
const baseAdapter = defineProvider({
  id: "runtime-test",
  version: "1.0.0",
  contractVersion: ProviderContractVersion,
  schemaVersion: "1",
  channel: "sms",
  identitySchema: Schema.Struct({ upstream: Schema.NonEmptyString }),
  secretsSchema: Schema.Struct({ token: Schema.RedactedFromValue(Schema.NonEmptyString) }),
  callbackSecretsSchema: Schema.Struct({
    callbackSecret: Schema.RedactedFromValue(Schema.NonEmptyString),
  }),
  executionSchema: Schema.Struct({
    sender: Schema.NonEmptyString,
    outcome: Schema.Literals(["accepted", "rejected", "uncertain"]),
  }),
  templateSchema: Schema.Struct({ text: Schema.NonEmptyString }),
  constraints: { minCodeLength: 6, maxCodeLength: 8, minDeliveryWindowMs: 0 },
  defaultSendTimeoutMs: 1000,
  diagnosticCodes: ["rejected", "uncertain"],
  idempotency: { supported: false },
  create: ({ secrets, execution }) => ({
    send: (input) =>
      Effect.gen(function* () {
        invocations.push({ token: Redacted.value(secrets.token), sender: execution.sender, input });
        if (execution.outcome === "rejected")
          return yield* Effect.fail(
            new ProviderRejected({ reason: "recipient_unavailable", diagnosticCode: "rejected" }),
          );
        if (execution.outcome === "uncertain")
          return yield* Effect.fail(new ProviderUncertain({ diagnosticCode: "uncertain" }));
        return { providerRequestId: `request:${input.attemptId}` };
      }),
  }),
  callback:
    ({ callbackSecrets, execution }) =>
    (input) =>
      Effect.gen(function* () {
        const callback = yield* FakeProvider.makeCallback({
          identity: { account: "test" },
          execution: { outcome: "accepted" },
          callbackSecrets: { callbackSecret: Redacted.value(callbackSecrets.callbackSecret) },
        }).pipe(Effect.orDie);
        if (callback === undefined) return yield* Effect.die(new Error("Missing fake callback"));
        const result = yield* callback(input);
        const metadata = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              sender: Schema.optionalKey(Schema.String),
              legacyEnvelope: Schema.optionalKey(Schema.Boolean),
              filterBySender: Schema.optionalKey(Schema.Boolean),
              events: Schema.Array(
                Schema.Struct({ id: Schema.String, sender: Schema.optionalKey(Schema.String) }),
              ),
            }),
          ),
        )(new TextDecoder().decode(input.body)).pipe(
          Effect.mapError(() => new CallbackFormatError({ diagnosticCode: "invalid_body" })),
        );
        if (metadata.legacyEnvelope === true && execution.sender === "r-first")
          return yield* Effect.fail(new CallbackFormatError({ diagnosticCode: "invalid_body" }));
        if (metadata.filterBySender === true && result._tag === "Events")
          return {
            _tag: "Events" as const,
            events: result.events.filter((event) =>
              metadata.events.some(
                (raw) => raw.id === event.deduplicationKey && raw.sender === execution.sender,
              ),
            ),
          };
        if (metadata.sender !== undefined && metadata.sender !== execution.sender)
          return yield* Effect.fail(
            new CallbackAuthenticationError({ diagnosticCode: "invalid_signature" }),
          );
        return result;
      }),
});
let openProviders = 0;
let onConstruct: (() => Promise<void>) | undefined;
const adapter: ProviderDefinition = {
  ...baseAdapter,
  makeCallback: (options) =>
    baseAdapter
      .makeCallback(options)
      .pipe(
        Effect.map((callback) =>
          Schema.is(Schema.Struct({ sender: Schema.Literal("no-callback") }))(options.execution)
            ? undefined
            : callback,
        ),
      ),
  make: (options) =>
    Layer.effect(
      ProviderInstance,
      Effect.gen(function* () {
        const base = yield* ProviderInstance;
        let open = true;
        openProviders++;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            open = false;
            openProviders--;
          }),
        );
        const hook = onConstruct;
        if (hook !== undefined) yield* Effect.promise(hook);
        return {
          ...base,
          resolveTemplate: (locales) =>
            Effect.suspend(() =>
              open
                ? base.resolveTemplate(locales)
                : Effect.die(new Error("Template resource already closed")),
            ),
          send: (input) =>
            Effect.suspend(() =>
              open ? base.send(input) : Effect.die(new Error("Send resource already closed")),
            ),
        };
      }),
    ).pipe(Layer.provide(baseAdapter.make(options))),
};
const ring = (byte: number) => ({
  active: "a",
  keys: { a: Buffer.alloc(32, byte).toString("base64url") },
});
let selectorBarrier: { readonly entered: () => void; readonly wait: Promise<void> } | undefined;
const configuration: FixtureConfiguration = {
  selectors: {
    "r-selector": () =>
      Effect.gen(function* () {
        const barrier = selectorBarrier;
        if (barrier !== undefined) {
          barrier.entered();
          yield* Effect.promise(() => barrier.wait);
        }
        return { _tag: "Route" as const, providerInstanceIds: ["r-first"] };
      }),
  },
  adapters: [adapter],
  providerFixtures: [],
  fixtures: { policies: {} },
  settings: {
    crypto: {
      deploymentId: "runtime",
      encryption: ring(1),
      verification: ring(2),
      fingerprint: ring(3),
      recipientKey: Buffer.alloc(32, 4).toString("base64url"),
    },
    deploymentSendLimit15m: 1000,
    deploymentSendLimit24h: 10000,
    administration: {
      principalIds: ["backend"],
      authorizationFloor: false,
      administrators: {
        admin: {
          actions: ["create", "read", "update", "grant", "revoke", "audit"],
          projectIds: ["demo", "alpha", "beta"],
          creationPrefixes: [],
          grantablePrincipalIds: ["backend"],
          editableSettings: ["authorizationRequired", "sendLimit15m", "sendLimit24h"],
          sendLimit15mCeiling: 1000000,
          sendLimit24hCeiling: 1000000,
          mayDisableAuthorization: true,
          runtimeActions: ["read", "manage", "rotate", "policy", "assign", "audit"],
          resourceIds: [],
          resourcePrefixes: ["r"],
        },
      },
    },
  },
};
let database: PostgresFixture | undefined;
let runtime: IntegrationRuntime | undefined;
const app = () => {
  if (runtime === undefined) throw new Error("Missing runtime");
  return runtime;
};
const mutate = (command: typeof RuntimeCommand.Type, key = randomUUID()) =>
  Effect.runPromise(app().runtime.mutate({ actorId: "admin", key, command }));
const read = (kind: typeof ResourceKind.Type, id: string) =>
  Effect.runPromise(app().runtime.get("admin", kind, id));
const lifecycle = async (
  kind: Exclude<typeof ResourceKind.Type, "scope">,
  id: string,
  state: "enabled" | "disabled" | "retired",
) =>
  mutate({
    action: "lifecycle",
    kind,
    id,
    state,
    expectedRevision: (await read(kind, id)).revision,
  });
const grant = async (
  kind: "instance" | "policy",
  id: string,
  projectId = "demo",
  action: "grant" | "revoke" = "grant",
) => mutate({ action, kind, id, projectId, expectedRevision: (await read(kind, id)).revision });
const rotate = async (id: string, purpose: "send" | "callback", secrets: Schema.Json) =>
  mutate({
    action: "rotate",
    kind: "account",
    id,
    purpose,
    secrets,
    expectedRevision: (await read("account", id)).revision,
  });
const settings = (sender: string, outcome: "accepted" | "rejected" | "uncertain" = "accepted") => ({
  label: sender,
  execution: { sender, outcome },
  templates: { en: { text: "Code {{code}}" } },
  sendTimeoutMs: 1000,
});
const updateInstance = async (
  id: string,
  outcome: "accepted" | "rejected" | "uncertain",
  sender = "changed",
) =>
  mutate({
    action: "update",
    kind: "instance",
    id,
    expectedRevision: (await read("instance", id)).revision,
    settings: settings(sender, outcome),
  });
const policy: Policy = {
  providerInstanceIds: ["r-first", "r-second"],
  purposes: ["login"],
  external: true,
  managed: { codeLength: 6, lifetimeSeconds: 300, maxIncorrectGuesses: 5 },
  maxLifetimeSeconds: 900,
  maxSends: 6,
  resendCooldownSeconds: 30,
  manualSelectionEnabled: true,
  manualProviderIds: ["r-first", "r-second"],
  fallback: "confirmed_failure",
  defaultLocale: "en",
  fallbackLocales: [],
};
const createAccount = async (id: string, instanceId: string) => {
  await mutate({
    action: "create",
    id,
    data: {
      kind: "account",
      adapterId: adapter.id,
      schemaVersion: "1",
      identity: { upstream: id },
      scopeIds: ["r-shared"],
    },
    firstInstance: { id: instanceId, settings: settings(instanceId), scopeIds: ["r-shared"] },
  });
  await rotate(id, "send", { token: `secret-${id}` });
  await rotate(id, "callback", { callbackSecret: "callback-old" });
  await lifecycle("account", id, "enabled");
  await lifecycle("instance", instanceId, "enabled");
};
const input = (phoneNumber = "+998901234567") => ({
  recipient: { type: "phone" as const, phoneNumber },
  purpose: "login",
  policyId: "r-policy",
  contextId: "flow",
});
const create = async (
  capability: "managed" | "external" = "external",
  projectId = "demo",
  phoneNumber = "+998901234567",
) => {
  const request = { projectId, principalId: "backend", key: randomUUID(), requestId: randomUUID() };
  return capability === "managed"
    ? Effect.runPromise(app().router.create({ ...request, input: input(phoneNumber) }))
    : Effect.runPromise(
        app().delivery.create({
          ...request,
          input: {
            ...input(phoneNumber),
            code: "123456",
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          },
        }),
      );
};
const job = async () => {
  const work = (await app().queue.fetch(deliveryQueue))[0];
  if (work === undefined) throw new Error("Missing delivery job");
  return Schema.decodeUnknownSync(DeliveryJob)(work.data);
};
const callbackService = () =>
  app().run(
    Effect.scoped(
      Layer.build(ProviderCallbacksLive).pipe(
        Effect.provideService(RouterConfig, app().configuration),
        Effect.map((context) => Context.get(context, ProviderCallbacks)),
      ),
    ),
  );
const callbackRequest = (
  instanceId: string,
  attemptId: string,
  secret: string,
  status = "delivered",
) => {
  const body = new TextEncoder().encode(
    JSON.stringify({
      events: [{ id: randomUUID(), correlationReference: { _tag: "Attempt", attemptId }, status }],
    }),
  );
  return {
    providerInstanceId: instanceId,
    callback: {
      body,
      method: "POST",
      path: `/webhooks/${instanceId}`,
      query: {},
      headers: { "x-fake-signature": signFakeCallback(secret, body) },
    },
  };
};
beforeAll(async () => {
  database = await startPostgres();
  runtime = await startRuntime(database.databaseUrl, configuration);
}, 30000);
beforeEach(async () => {
  await app().reset();
  invocations.length = 0;
  await mutate({
    action: "create",
    id: "r-shared",
    data: { kind: "scope", limits: { sendLimit15m: 100, sendLimit24h: 1000 } },
  });
  await createAccount("r-account-one", "r-first");
  await createAccount("r-account-two", "r-second");
  await mutate({ action: "create", id: "r-policy", data: { kind: "policy", settings: policy } });
  await lifecycle("policy", "r-policy", "enabled");
  await grant("policy", "r-policy");
  await grant("instance", "r-first");
  await grant("instance", "r-second");
});
afterAll(async () => {
  await runtime?.close();
  await database?.close();
});

it("filters unauthorized steps without policy access implying provider access; validates and reserves identities", async () => {
  const instanceAudit = await Effect.runPromise(
    app().runtime.audit("admin", "instance", "r-first", {}),
  );
  expect(instanceAudit.events[0]).toMatchObject({
    action: "create",
    revision: 1,
    actorId: "admin",
  });
  await grant("policy", "r-policy", "alpha");
  await expect(create("external", "alpha")).rejects.toMatchObject({ code: "delivery_unavailable" });
  await grant("instance", "r-second", "alpha");
  const created = await create("external", "alpha");
  const h = app();
  expect(
    await h.run(
      rows(
        Schema.Struct({ provider_instance_id: Schema.String }),
        h.pg`SELECT provider_instance_id FROM otp_router.operation_route_steps WHERE operation_id = ${created.body.operationId}`,
      ),
    ),
  ).toEqual([{ provider_instance_id: "r-second" }]);
  const appended = await h.run(
    h.pg`INSERT INTO otp_router.operation_route_steps(operation_id,position,provider_instance_id,label,plugin_id,contract_version,channel,resolved_locale,template,send_timeout_ms,min_delivery_window_ms,account_id,instance_revision,min_code_length,max_code_length,manual_selection_allowed)
      SELECT operation_id,1,'r-first',label,plugin_id,contract_version,channel,resolved_locale,template,send_timeout_ms,min_delivery_window_ms,'r-account-one',1,min_code_length,max_code_length,manual_selection_allowed
      FROM otp_router.operation_route_steps WHERE operation_id = ${created.body.operationId} AND position = 0`.pipe(
      Effect.result,
    ),
  );
  expect(appended).toMatchObject({
    _tag: "Failure",
    failure: { reason: { cause: { code: "23514" } } },
  });
  await expect(
    mutate({
      action: "create",
      id: "r-bad",
      data: {
        kind: "account",
        adapterId: adapter.id,
        schemaVersion: "1",
        identity: { upstream: "x", token: "must-not-be-public" },
        scopeIds: [],
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    mutate({
      action: "create",
      id: "r-bad",
      data: {
        kind: "account",
        adapterId: adapter.id,
        schemaVersion: "1",
        identity: { upstream: "x" },
        scopeIds: [],
      },
      firstInstance: {
        id: "r-bad-instance",
        settings: { ...settings("bad"), templates: { en: { invalid: true } } },
        scopeIds: [],
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(read("account", "r-bad")).rejects.toMatchObject({ code: "resource_not_found" });
  await lifecycle("account", "r-account-one", "retired");
  await expect(lifecycle("account", "r-account-one", "enabled")).rejects.toMatchObject({
    code: "invalid_request",
  });
});

it("preserves runtime identities, immutable revisions and revoked grant lifetimes in storage", async () => {
  await mutate({
    action: "create",
    id: "r-extra",
    data: { kind: "scope", limits: { sendLimit15m: 1, sendLimit24h: 1 } },
  });
  await mutate({
    action: "create",
    id: "r-third",
    data: {
      kind: "instance",
      accountId: "r-account-two",
      settings: settings("r-third"),
      scopeIds: [],
    },
  });
  await grant("instance", "r-first", "demo", "revoke");
  await lifecycle("account", "r-account-one", "retired");
  const sql = app().pg;
  for (const change of [
    sql`UPDATE otp_router.provider_accounts SET state = 'enabled' WHERE id = 'r-account-one'`,
    sql`UPDATE otp_router.provider_instances SET account_id = 'r-account-two' WHERE id = 'r-first'`,
    sql`DELETE FROM otp_router.instance_allowances WHERE instance_id = 'r-first'`,
    sql`INSERT INTO otp_router.instance_allowances(instance_id,scope_id) VALUES ('r-first','r-extra')`,
    sql`INSERT INTO otp_router.policy_steps(policy_id,revision,position,instance_id,manual_selection_allowed) VALUES ('r-policy',1,2,'r-third',false)`,
    sql`UPDATE otp_router.instance_revisions SET settings = jsonb_set(settings,'{label}','"rewritten"') WHERE instance_id = 'r-first'`,
    sql`UPDATE otp_router.runtime_grants SET revoked_at = NULL WHERE kind = 'instance' AND resource_id = 'r-first' AND project_id = 'demo'`,
    sql`UPDATE otp_router.runtime_grants SET project_id = 'alpha' WHERE kind = 'instance' AND resource_id = 'r-first' AND project_id = 'demo'`,
  ]) {
    expect(await app().run(change.pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
      failure: { reason: { cause: { code: "23514" } } },
    });
  }
  await mutate({
    action: "create",
    id: "r-reserved",
    data: { kind: "scope", limits: { sendLimit15m: 1, sendLimit24h: 1 } },
  });
  expect(await read("scope", "r-reserved")).toEqual({
    id: "r-reserved",
    revision: 1,
    data: { kind: "scope", limits: { sendLimit15m: 1, sendLimit24h: 1 } },
  });
  expect(
    await app().run(
      sql`DELETE FROM otp_router.allowance_scopes WHERE id = 'r-reserved'`.pipe(Effect.result),
    ),
  ).toMatchObject({ _tag: "Failure" });
});

it("enforces account ownership, allowance membership, policy targets and credential purpose with foreign keys", async () => {
  const sql = app().pg;
  const account = await read("account", "r-account-one");
  const other = await read("account", "r-account-two");
  for (const change of [
    sql`INSERT INTO otp_router.provider_instances(id,account_id) VALUES ('r-orphan','r-missing')`,
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO otp_router.provider_accounts(id,adapter_id,schema_version,identity) VALUES ('r-new-account','runtime-test','1','{}')`;
        yield* sql`INSERT INTO otp_router.account_allowances(account_id,scope_id) VALUES ('r-new-account','r-missing')`;
      }),
    ),
    sql`INSERT INTO otp_router.instance_allowances(instance_id,scope_id) VALUES ('r-missing','r-shared')`,
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO otp_router.policy_revisions(policy_id,revision,settings) SELECT policy_id,999,settings FROM otp_router.policy_revisions WHERE policy_id = 'r-policy' AND revision = 1`;
        yield* sql`INSERT INTO otp_router.policy_steps(policy_id,revision,position,instance_id,manual_selection_allowed) VALUES ('r-policy',999,0,'r-missing',false)`;
      }),
    ),
    sql`INSERT INTO otp_router.runtime_grants(id,project_id,instance_id) VALUES (${randomUUID()},'demo','r-missing')`,
    sql`INSERT INTO otp_router.account_secret_versions(id,account_id,purpose) VALUES (${randomUUID()},'r-missing','send')`,
    sql`UPDATE otp_router.account_current_secrets SET version_id = ${other.sendCredentialVersion} WHERE account_id = 'r-account-one' AND purpose = 'send'`,
    sql`UPDATE otp_router.account_current_secrets SET version_id = ${account.callbackVersion} WHERE account_id = 'r-account-one' AND purpose = 'send'`,
  ])
    expect(await app().run(change.pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
      failure: { reason: { cause: { code: "23503" } } },
    });
  expect((await read("account", account.id)).sendCredentialVersion).toBe(
    account.sendCredentialVersion,
  );
});

it("treats policy manual choices as membership for no-op updates", async () => {
  const current = await read("policy", "r-policy");
  const noop = await mutate({
    action: "update",
    kind: "policy",
    id: current.id,
    expectedRevision: current.revision,
    settings: { ...policy, manualProviderIds: [...policy.manualProviderIds].reverse() },
  });
  expect(noop.body.revision).toBe(current.revision);
});

it.each(["managed", "external"] as const)(
  "preserves %s snapshots, selects current credentials once, and never retries uncertainty",
  async (capability) => {
    await updateInstance("r-first", "uncertain", "original");
    const created = await create(capability);
    const work = await job();
    await updateInstance("r-first", "accepted", "replacement");
    const currentPolicy = await read("policy", "r-policy");
    await mutate({
      action: "update",
      kind: "policy",
      id: currentPolicy.id,
      expectedRevision: currentPolicy.revision,
      settings: {
        ...policy,
        providerInstanceIds: ["r-second"],
        manualProviderIds: [],
        managed: { codeLength: 8, lifetimeSeconds: 120, maxIncorrectGuesses: 2 },
        maxSends: 1,
      },
    });
    const rotated = await rotate("r-account-one", "send", { token: "new-send-secret" });
    await app().run(dispatch(app().configuration, work));
    await app().run(dispatch(app().configuration, work));
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      token: "new-send-secret",
      sender: "original",
      input: { template: { text: "Code {{code}}" }, locale: "en" },
    });
    const h = app();
    expect(
      await h.run(
        rows(
          Schema.Struct({ credential_version_id: Schema.String, state: Schema.String }),
          h.pg`SELECT credential_version_id,state FROM otp_router.delivery_attempts WHERE id = ${work.attemptId}`,
        ),
      ),
    ).toEqual([{ credential_version_id: rotated.body.sendCredentialVersion, state: "uncertain" }]);
    expect(await h.queue.fetch(deliveryQueue)).toHaveLength(0);
    const history = await Effect.runPromise(h.history.attempt("demo", work.attemptId, "backend"));
    expect(history.operationId).toBe(created.body.operationId);
  },
);

it("keeps committed credentials and older callback keys through rotation, retirement, and late evidence", async () => {
  await create();
  const work = await job();
  const reserved = await app().run(dispatchGate(app().configuration, work));
  if (reserved === undefined) throw new Error("Missing committed dispatch");
  const old = await read("account", "r-account-one");
  await rotate(old.id, "send", { token: "rotated" });
  await rotate(old.id, "callback", { callbackSecret: "callback-new" });
  await app().run(cleanupRuntimeSecrets(app().configuration));
  expect(
    await app().run(
      secretVersion(app().configuration, old.id, "send", old.sendCredentialVersion ?? "missing"),
    ),
  ).toEqual({ token: "secret-r-account-one" });
  await Effect.runPromise(
    Effect.scoped(
      constructProvider(reserved.prepared).pipe(
        Effect.flatMap((provider) => provider.send(reserved.input)),
      ),
    ),
  );
  expect(invocations[0]?.token).toBe("secret-r-account-one");
  await lifecycle("account", old.id, "retired");
  const callbacks = await callbackService();
  await Effect.runPromise(
    callbacks.ingest(callbackRequest("r-second", work.attemptId, "callback-old")),
  );
  expect(
    (await Effect.runPromise(app().history.attempt("demo", work.attemptId, "backend"))).state,
  ).toBe("dispatching");
  await Effect.runPromise(
    callbacks.ingest(callbackRequest("r-first", work.attemptId, "callback-old")),
  );
  expect(
    (await Effect.runPromise(app().history.attempt("demo", work.attemptId, "backend"))).state,
  ).toBe("delivered");
  await app().run(cleanupRuntimeSecrets(app().configuration));
  await expect(
    app().run(
      secretVersion(app().configuration, old.id, "send", old.sendCredentialVersion ?? "missing"),
    ),
  ).rejects.toMatchObject({ code: "delivery_unavailable" });
  expect(
    await Effect.runPromise(
      callbacks.decode(callbackRequest("r-first", work.attemptId, "callback-old")),
    ),
  ).toMatchObject({ _tag: "Events" });
  await mutate({
    action: "revoke-secret",
    kind: "account",
    id: old.id,
    expectedRevision: (await read("account", old.id)).revision,
    versionId: old.callbackVersion ?? "missing",
  });
  await expect(
    Effect.runPromise(callbacks.ingest(callbackRequest("r-first", work.attemptId, "callback-old"))),
  ).rejects.toMatchObject({ code: "unauthorized" });
});

it.each([
  { kind: "instance", change: "grant" },
  { kind: "policy", change: "grant" },
  { kind: "account", change: "lifecycle" },
  { kind: "instance", change: "lifecycle" },
  { kind: "policy", change: "lifecycle" },
] as const)(
  "does not revive queued $kind authority after $change restoration, but accepts a new explicit action",
  async ({ kind, change }) => {
    const created = await create();
    const work = await job();
    const id = kind === "account" ? "r-account-one" : kind === "instance" ? "r-first" : "r-policy";
    if (change === "grant") {
      await grant(kind, id, "demo", "revoke");
      await grant(kind, id);
    } else {
      await lifecycle(kind, id, "disabled");
      await lifecycle(kind, id, "enabled");
    }
    await app().run(dispatch(app().configuration, work));
    expect(invocations).toHaveLength(0);
    if (kind !== "policy") {
      const next = await job();
      await app().run(dispatch(app().configuration, next));
    }
    expect(invocations.map((entry) => entry.sender)).toEqual(kind !== "policy" ? ["r-second"] : []);
    const h = app();
    await h.run(
      h.pg`UPDATE otp_router.delivery_operations SET next_user_send_at = clock_timestamp() WHERE id = ${created.body.operationId}`,
    );
    await ageAdmission(h);
    await Effect.runPromise(
      h.delivery.deliver({
        principalId: "backend",
        projectId: "demo",
        operationId: created.body.operationId,
        key: randomUUID(),
        requestId: randomUUID(),
        input: { action: "select", choice: { type: "provider", providerInstanceId: "r-first" } },
      }),
    );
    await h.run(dispatch(h.configuration, await job()));
    expect(invocations.at(-1)?.sender).toBe("r-first");
  },
);

it("invalidates saved configuration explicitly and honors disabled automatic fallback", async () => {
  await create();
  const work = await job();
  const instance = await read("instance", "r-first");
  if (instance.configurationRevision === undefined) throw new Error("Missing instance revision");
  await mutate({
    action: "invalidate",
    kind: "instance",
    id: instance.id,
    revision: instance.configurationRevision,
    expectedRevision: instance.revision,
  });
  await app().run(dispatch(app().configuration, work));
  await app().run(dispatch(app().configuration, await job()));
  expect(invocations.map((entry) => entry.sender)).toEqual(["r-second"]);
  await updateInstance("r-first", "rejected");
  const before = await read("policy", "r-policy");
  await mutate({
    action: "update",
    kind: "policy",
    id: before.id,
    expectedRevision: before.revision,
    settings: { ...policy, fallback: "disabled" },
  });
  await create("external", "demo", "+998901234568");
  await app().run(dispatch(app().configuration, await job()));
  expect(await app().queue.fetch(deliveryQueue)).toHaveLength(0);
});

it("shares allowance consumption across accounts, projects and capabilities without duplicate memberships or resets", async () => {
  const scope = await read("scope", "r-shared");
  expect(scope).not.toHaveProperty("state");
  expect(scope).not.toHaveProperty("epoch");
  expect(scope).not.toHaveProperty("configurationRevision");
  await mutate({
    action: "update",
    kind: "scope",
    id: scope.id,
    expectedRevision: scope.revision,
    settings: { sendLimit15m: 1, sendLimit24h: 1000 },
  });
  await grant("policy", "r-policy", "alpha");
  await grant("instance", "r-second", "alpha");
  await create("managed");
  const first = await job();
  await create("external", "alpha");
  const second = await job();
  await Promise.all([
    app().run(dispatch(app().configuration, first)),
    app().run(dispatch(app().configuration, second)),
  ]);
  expect(invocations).toHaveLength(1);
  const h = app();
  expect(
    await h.run(
      rows(
        Schema.Struct({ count: Schema.Int }),
        h.pg`SELECT count(*)::int AS count FROM otp_router.quota_allocations WHERE scope = 'shared' AND scope_id = 'r-shared' AND kind = 'send'`,
      ),
    ),
  ).toEqual([{ count: 1 }]);
  const current = await read("scope", scope.id);
  await mutate({
    action: "update",
    kind: "scope",
    id: scope.id,
    expectedRevision: current.revision,
    settings: { sendLimit15m: 2, sendLimit24h: 1000 },
  });
  expect(
    await h.run(
      rows(
        Schema.Struct({ count: Schema.Int }),
        h.pg`SELECT count(*)::int AS count FROM otp_router.quota_allocations WHERE scope = 'shared' AND scope_id = 'r-shared' AND kind = 'send'`,
      ),
    ),
  ).toEqual([{ count: 1 }]);
});

it("commits secret-free replay and audit atomically, checks current rotation permission, and retains key references", async () => {
  const before = await read("account", "r-account-one");
  const key = randomUUID();
  const command: typeof RuntimeCommand.Type = {
    action: "rotate",
    kind: "account",
    id: before.id,
    expectedRevision: before.revision,
    purpose: "send",
    secrets: { token: "high-entropy-secret-never-in-receipts" },
  };
  const result = await mutate(command, key);
  expect(await mutate(command, key)).toEqual({ ...result, replayed: true });
  await expect(mutate({ ...command, secrets: { token: "changed" } }, key)).rejects.toMatchObject({
    code: "idempotency_conflict",
  });
  const h = app();
  const admin = h.configuration.settings.administration.administrators["admin"];
  if (admin === undefined) throw new Error("Missing admin");
  const denied = {
    ...h.configuration,
    settings: {
      ...h.configuration.settings,
      administration: {
        ...h.configuration.settings.administration,
        administrators: { admin: { ...admin, runtimeActions: ["read" as const] } },
      },
    },
  };
  await expect(
    h.run(mutateRuntime(denied, { actorId: "admin", key, command })),
  ).rejects.toMatchObject({ code: "admin_forbidden" });
  const persisted = await h.run(
    rows(
      Schema.Struct({ value: Schema.String }),
      h.pg`SELECT response::text AS value FROM otp_router.runtime_receipts UNION ALL SELECT data::text FROM otp_router.runtime_resources UNION ALL SELECT row_to_json(e)::text FROM otp_router.runtime_events e UNION ALL SELECT ciphertext::text FROM otp_router.account_secret_versions WHERE ciphertext IS NOT NULL`,
    ),
  );
  expect(JSON.stringify(persisted)).not.toContain("high-entropy-secret");
  const audit = await Effect.runPromise(h.runtime.audit("admin", "account", before.id, {}));
  expect(audit.events.filter((event) => event.revision === result.body.revision)).toHaveLength(1);
  await expect(
    h.run(
      validateStoredKeys({
        ...h.configuration.settings,
        crypto: {
          ...h.configuration.settings.crypto,
          encryption: ring(9),
          fingerprint: { active: "new", keys: { new: Buffer.alloc(32, 8).toString("base64url") } },
        },
      }),
    ),
  ).rejects.toMatchObject({ reason: "retained_key_missing" });
});

it("serializes disable against dispatch commitment while permitting an already committed invocation", async () => {
  const created = await create();
  const work = await job();
  const h = app();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = h.run(
    h.pg.withTransaction(
      Effect.gen(function* () {
        const record = (yield* rows(
          Schema.Struct({ recipient_token: Schema.String }),
          h.pg`SELECT recipient_token FROM otp_router.delivery_operations WHERE id = ${created.body.operationId}`,
        ))[0];
        if (record === undefined) return yield* Effect.die(new Error("Missing operation"));
        yield* lockQuotas(
          yield* sendLimits(h.configuration.settings, record.recipient_token, "r-first", "demo"),
        );
        entered.resolve();
        yield* Effect.promise(() => release.promise);
      }),
    ),
  );
  await entered.promise;
  const sending = h.run(dispatchGate(h.configuration, work));
  const waitForBlocked = async () => {
    for (let i = 0; i < 500; i++) {
      const records = await h.run(
        rows(
          Schema.Struct({ blocked: Schema.Boolean }),
          h.pg`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock(%') AS blocked`,
        ),
      );
      if (records[0]?.blocked === true) return;
    }
    throw new Error("Dispatch did not reach quota lock");
  };
  try {
    await waitForBlocked();
    const disabling = lifecycle("account", "r-account-one", "disabled");
    release.resolve();
    await Promise.all([holder, disabling]);
    const committed = await sending;
    if (committed === undefined) throw new Error("Dispatch failed to commit");
    await Effect.runPromise(
      Effect.scoped(
        constructProvider(committed.prepared).pipe(
          Effect.flatMap((provider) => provider.send(committed.input)),
        ),
      ),
    );
  } finally {
    release.resolve();
    await holder;
  }
  expect(invocations).toHaveLength(1);
  expect((await read("account", "r-account-one")).state).toBe("disabled");
});

it.each(["policy", "instance"] as const)(
  "revalidates %s disable/re-enable after selector execution",
  async (kind) => {
    const current = await read("policy", "r-policy");
    await mutate({
      action: "update",
      kind: "policy",
      id: current.id,
      expectedRevision: current.revision,
      settings: { ...policy, selectorId: "r-selector" },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    selectorBarrier = { entered: () => entered.resolve(), wait: release.promise };
    const creating = create().then(
      () => ({ code: "unexpected-success" }),
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      const id = kind === "policy" ? "r-policy" : "r-first";
      await lifecycle(kind, id, "disabled");
      await lifecycle(kind, id, "enabled");
      release.resolve();
      expect(await creating).toMatchObject({
        code: kind === "policy" ? "policy_not_allowed" : "delivery_unavailable",
      });
    } finally {
      release.resolve();
      selectorBarrier = undefined;
      await creating;
    }
    expect(await app().queue.fetch(deliveryQueue)).toHaveLength(0);
    expect(invocations).toHaveLength(0);
  },
);

it("requires explicit account-wide access and rejects invalid policy bounds atomically", async () => {
  const account = await read("account", "r-account-one");
  const command = {
    action: "grant" as const,
    kind: "account" as const,
    id: account.id,
    expectedRevision: account.revision,
    projectId: "alpha",
  };
  expect(Schema.is(RuntimeCommand)(command)).toBe(false);
  await mutate({ ...command, allInstances: true });
  await grant("policy", "r-policy", "alpha");
  await create("external", "alpha");
  await app().run(dispatch(app().configuration, await job()));
  expect(invocations.map((entry) => entry.sender)).toEqual(["r-first"]);
  for (const invalid of [
    {
      providerInstanceIds: policy.providerInstanceIds,
      purposes: policy.purposes,
      external: false,
      maxLifetimeSeconds: policy.maxLifetimeSeconds,
      maxSends: policy.maxSends,
      resendCooldownSeconds: policy.resendCooldownSeconds,
      manualSelectionEnabled: false,
      manualProviderIds: [],
      fallback: policy.fallback,
      defaultLocale: policy.defaultLocale,
      fallbackLocales: [],
    },
    { ...policy, managed: { codeLength: 5, lifetimeSeconds: 300, maxIncorrectGuesses: 5 } },
    { ...policy, managed: { codeLength: 6, lifetimeSeconds: 1000, maxIncorrectGuesses: 5 } },
    { ...policy, manualProviderIds: ["r-absent"] },
    { ...policy, defaultLocale: "fr", fallbackLocales: [] },
    { ...policy, providerInstanceIds: ["r-first", "r-first"] },
  ]) {
    await expect(
      mutate({ action: "create", id: "r-invalid", data: { kind: "policy", settings: invalid } }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  }
  await expect(read("policy", "r-invalid")).rejects.toMatchObject({ code: "resource_not_found" });
});

it("replays secret rotation durably after restart without changing the selected version", async () => {
  const before = await read("account", "r-account-one");
  const key = randomUUID();
  const command: typeof RuntimeCommand.Type = {
    action: "rotate",
    kind: "account",
    id: before.id,
    expectedRevision: before.revision,
    purpose: "send",
    secrets: { token: "durable-secret" },
  };
  const result = await mutate(command, key);
  if (database === undefined) throw new Error("Missing database");
  await app().close();
  runtime = await startRuntime(database.databaseUrl, configuration);
  expect(await mutate(command, key)).toEqual({ ...result, replayed: true });
  expect((await read("account", before.id)).sendCredentialVersion).toBe(
    result.body.sendCredentialVersion,
  );
  const audit = await Effect.runPromise(app().runtime.audit("admin", "account", before.id, {}));
  expect(audit.events.filter((event) => event.revision === result.body.revision)).toHaveLength(1);
});

it("preserves saved account grants when a narrower grant is added, including selector revalidation", async () => {
  await grant("instance", "r-first", "demo", "revoke");
  const account = await read("account", "r-account-one");
  await mutate({
    action: "grant",
    kind: "account",
    id: account.id,
    expectedRevision: account.revision,
    projectId: "demo",
    allInstances: true,
  });
  await create();
  const work = await job();
  await grant("instance", "r-first");
  await app().run(dispatch(app().configuration, work));
  expect(invocations.map((entry) => entry.sender)).toEqual(["r-first"]);
  await grant("instance", "r-first", "demo", "revoke");
  const current = await read("policy", "r-policy");
  await mutate({
    action: "update",
    kind: "policy",
    id: current.id,
    expectedRevision: current.revision,
    settings: { ...policy, selectorId: "r-selector" },
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  selectorBarrier = { entered: () => entered.resolve(), wait: release.promise };
  const creating = create("external", "demo", "+998901234568");
  try {
    await entered.promise;
    await grant("instance", "r-first");
    release.resolve();
    await creating;
  } finally {
    release.resolve();
    selectorBarrier = undefined;
    await creating;
  }
  expect(await app().queue.fetch(deliveryQueue)).toHaveLength(1);
});

it("keeps scoped provider resources alive through use and constructs outside the dispatch transaction", async () => {
  await create();
  const work = await job();
  expect(openProviders).toBe(0);
  onConstruct = async () => {
    onConstruct = undefined;
    await rotate("r-account-one", "send", { token: "rotated-after-commit" });
  };
  try {
    await app().run(dispatch(app().configuration, work));
  } finally {
    onConstruct = undefined;
  }
  expect(invocations).toHaveLength(1);
  expect(invocations[0]?.token).toBe("secret-r-account-one");
  expect(openProviders).toBe(0);
});

it("binds callback evidence and early inbox reconciliation to authenticated sender revisions", async () => {
  const callbacks = await callbackService();
  const report = (
    sender: string,
    reference:
      | { readonly _tag: "Attempt"; readonly attemptId: string }
      | { readonly _tag: "ProviderRequest"; readonly providerRequestId: string },
    status: string,
    legacyEnvelope = false,
  ) => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        sender,
        legacyEnvelope,
        events: [{ id: randomUUID(), correlationReference: reference, status }],
      }),
    );
    return callbacks.ingest({
      providerInstanceId: "r-first",
      callback: {
        body,
        method: "POST",
        path: "/webhooks/r-first",
        query: {},
        headers: { "x-fake-signature": signFakeCallback("callback-old", body) },
      },
    });
  };
  const filteredReport = (sender: string, attemptId: string, status: string) => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        filterBySender: true,
        events: [
          {
            id: randomUUID(),
            sender,
            correlationReference: { _tag: "Attempt", attemptId },
            status,
          },
        ],
      }),
    );
    return callbacks.ingest({
      providerInstanceId: "r-first",
      callback: {
        body,
        method: "POST",
        path: "/webhooks/r-first",
        query: {},
        headers: { "x-fake-signature": signFakeCallback("callback-old", body) },
      },
    });
  };
  await create();
  const old = await job();
  await app().run(dispatch(app().configuration, old));
  await updateInstance("r-first", "uncertain", "replacement");
  await create("external", "demo", "+998901234568");
  const newer = await job();
  await app().run(dispatch(app().configuration, newer));
  await Effect.runPromise(
    report("r-first", { _tag: "Attempt", attemptId: newer.attemptId }, "failed"),
  );
  expect(
    (await Effect.runPromise(app().history.attempt("demo", newer.attemptId, "backend"))).state,
  ).toBe("uncertain");
  expect(await app().queue.fetch(deliveryQueue)).toHaveLength(0);
  await Effect.runPromise(filteredReport("replacement", old.attemptId, "failed"));
  expect(
    (await Effect.runPromise(app().history.attempt("demo", old.attemptId, "backend"))).state,
  ).toBe("accepted");
  expect(await app().queue.fetch(deliveryQueue)).toHaveLength(0);
  await Effect.runPromise(filteredReport("r-first", old.attemptId, "delivered"));
  expect(
    (await Effect.runPromise(app().history.attempt("demo", old.attemptId, "backend"))).state,
  ).toBe("delivered");
  const current = await read("instance", "r-first");
  await mutate({
    action: "update",
    kind: "instance",
    id: current.id,
    expectedRevision: current.revision,
    settings: { ...settings("replacement", "uncertain"), label: "changed label" },
  });
  await Effect.runPromise(
    report("replacement", { _tag: "Attempt", attemptId: newer.attemptId }, "delivered", true),
  );
  expect(
    (await Effect.runPromise(app().history.attempt("demo", newer.attemptId, "backend"))).state,
  ).toBe("delivered");
  await updateInstance("r-first", "accepted", "replacement");
  await create("external", "demo", "+998901234569");
  const early = await job();
  await Effect.runPromise(
    report(
      "r-first",
      { _tag: "ProviderRequest", providerRequestId: `request:${early.attemptId}` },
      "failed",
    ),
  );
  await app().run(dispatch(app().configuration, early));
  expect(
    (await Effect.runPromise(app().history.attempt("demo", early.attemptId, "backend"))).state,
  ).toBe("accepted");
  expect(await app().queue.fetch(deliveryQueue)).toHaveLength(0);
  await updateInstance("r-first", "accepted", "no-callback");
  await Effect.runPromise(
    report(
      "replacement",
      { _tag: "ProviderRequest", providerRequestId: `request:${early.attemptId}` },
      "delivered",
    ),
  );
  expect(
    (await Effect.runPromise(app().history.attempt("demo", early.attemptId, "backend"))).state,
  ).toBe("delivered");
});

it("does not construct obsolete callback configurations after a drained adapter upgrade", async () => {
  await updateInstance("r-first", "accepted", "obsolete");
  await updateInstance("r-first", "accepted", "current");
  const upgraded: ProviderDefinition = {
    ...adapter,
    version: "2.0.0",
    makeCallback: (options) =>
      Schema.is(Schema.Struct({ sender: Schema.Literal("obsolete") }))(options.execution)
        ? Effect.fail(new ProviderConfigurationError({ diagnosticCode: "obsolete_sender" }))
        : adapter.makeCallback(options),
  };
  if (database === undefined) throw new Error("Missing database");
  await app().close();
  try {
    runtime = await startRuntime(database.databaseUrl, { ...configuration, adapters: [upgraded] });
    await create();
    const work = await job();
    await app().run(dispatch(app().configuration, work));
    const callbacks = await callbackService();
    await Effect.runPromise(
      callbacks.ingest(callbackRequest("r-first", work.attemptId, "callback-old")),
    );
    expect(
      (await Effect.runPromise(app().history.attempt("demo", work.attemptId, "backend"))).state,
    ).toBe("delivered");
  } finally {
    await app().close();
    runtime = await startRuntime(database.databaseUrl, configuration);
  }
});
