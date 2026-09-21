import { randomUUID } from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";
import { EngineControl, makeEngineLayer } from "@otp-router/engine";
import { loadConfiguration } from "@otp-router/engine/config";
import { Delivery } from "@otp-router/engine/delivery";
import { FakeProvider, ProviderInstanceIdSchema } from "@otp-router/engine/providers";

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
      defaultLocale: "en",
      fallbackLocales: [],
      policies: { login: { providerInstanceIds: ["fake"], maxLifetimeSeconds: 900 } },
      purposes: { login: ["login"] },
      deploymentSendLimit15m: 100,
      deploymentSendLimit24h: 1000,
    },
    providers: [
      FakeProvider.make({
        instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)("fake"),
        enabled: true,
        settingsFingerprint: "external-code-demo",
        config: { outcome: "accepted", callbackSecret: Redacted.make("demo-callback") },
        templates: {},
      }),
    ],
  });
  const context = yield* Layer.build(
    makeEngineLayer({ databaseUrl: Redacted.make(databaseUrl), configuration }),
  );
  const delivery = Context.get(context, Delivery);
  const control = Context.get(context, EngineControl);
  yield* control.startWorkers({ concurrency: 1, shutdownGraceMs: 5000 });
  const prepared = yield* delivery.prepare({
    key: randomUUID(),
    requestId: randomUUID(),
    input: {
      recipient: { type: "phone", phoneNumber: "+998901234567" },
      purpose: "login",
      contextId: randomUUID(),
      policyId: "login",
      expiresAt: new Date(Date.now() + 890000).toISOString(),
    },
  });
  const operationId = prepared.body.operationId;
  // In a real consumer, its external authority supplies this code and verifies it.
  yield* delivery.submitCode({
    operationId,
    key: randomUUID(),
    requestId: randomUUID(),
    input: { code: "123456" },
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = yield* delivery.status(operationId);
    if (status.body.state === "accepted") {
      yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(status.body)}\n`));
      yield* delivery.close({ operationId, key: randomUUID(), requestId: randomUUID(), input: {} });
      return;
    }
    yield* Effect.sleep("200 millis");
  }
  return yield* Effect.fail(new DemoTimeout());
});
await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer), Effect.scoped));
