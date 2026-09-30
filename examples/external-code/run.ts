import { RuntimeAdministration } from "@otp-router/engine/runtime";
import { demoCommands } from "../admin/provisioning.js";
import { Projects } from "@otp-router/engine/projects";
import { randomUUID } from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { Context, Data, Effect, Layer, Redacted } from "effect";
import { EngineControl, makeEngineLayer } from "@otp-router/engine";
import { loadConfiguration } from "@otp-router/engine/config";
import { Delivery } from "@otp-router/engine/delivery";
import { FakeProvider } from "@otp-router/engine/providers";

class DemoTimeout extends Data.TaggedError("DemoTimeout")<{}> {}

const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined)
  throw new Error("Set DATABASE_URL to a disposable PostgreSQL database");
// Stable demo keys permit repeated runs against the same disposable database.
const ring = (byte: number) => ({
  active: "demo",
  keys: { demo: Buffer.alloc(32, byte).toString("base64url") },
});
const program = Effect.gen(function* () {
  const configuration = yield* loadConfiguration({
    settings: {
      crypto: {
        deploymentId: "external-code-demo",
        encryption: ring(1),
        fingerprint: ring(2),
        recipientKey: Buffer.alloc(32, 3).toString("base64url"),
      },
      administration: {
        principalIds: ["backend"],
        administrators: {
          admin: {
            runtimeActions: ["read", "manage", "rotate", "policy", "assign", "audit"],
            resourceIds: [],
            resourcePrefixes: [
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
    adapters: [FakeProvider],
  });
  const context = yield* Layer.build(
    makeEngineLayer({ databaseUrl: Redacted.make(databaseUrl), configuration }),
  );
  const projects = Context.get(context, Projects);
  yield* projects.mutate({
    actorId: "admin",
    key: "external-demo-project",
    command: {
      action: "create",
      input: {
        id: "demo",
        settings: { authorizationRequired: false, sendLimit15m: 10000, sendLimit24h: 100000 },
        principalIds: ["backend"],
      },
    },
  });
  const administration = Context.get(context, RuntimeAdministration);
  for (const [index, command] of demoCommands("demo-callback", false, "fake").entries())
    yield* administration.mutate({ actorId: "admin", key: `external-runtime-${index}`, command });
  const delivery = Context.get(context, Delivery);
  const control = Context.get(context, EngineControl);
  yield* control.startWorkers({ concurrency: 1, shutdownGraceMs: 5000 });
  const prepared = yield* delivery.prepare({
    principalId: "backend",
    projectId: "demo",
    key: randomUUID(),
    requestId: randomUUID(),
    input: {
      recipient: { type: "phone", phoneNumber: "+998901234567" },
      purpose: "login",
      contextId: randomUUID(),
      integrationReference: `Flow.${randomUUID()}`,
      policyId: "login",
      expiresAt: new Date(Date.now() + 890000).toISOString(),
    },
  });
  const operationId = prepared.body.operationId;
  // In a real consumer, its external authority supplies this code and verifies it.
  yield* delivery.submitCode({
    principalId: "backend",
    operationId,
    projectId: "demo",
    key: randomUUID(),
    requestId: randomUUID(),
    input: { code: "123456" },
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = yield* delivery.status("demo", operationId, "backend");
    if (status.body.state === "accepted") {
      yield* Effect.sync(() =>
        process.stdout.write(`Operation ${operationId}: ${status.body.state}\n`),
      );
      yield* delivery.close({
        principalId: "backend",
        operationId,
        projectId: "demo",
        key: randomUUID(),
        requestId: randomUUID(),
        input: {},
      });
      return;
    }
    yield* Effect.sleep("200 millis");
  }
  return yield* Effect.fail(new DemoTimeout());
});
await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer), Effect.scoped));
