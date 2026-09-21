import { createHash, createHmac } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect";
import {
  OperationIdSchema,
  AttemptIdSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  NormalizedPhoneSchema,
  OtpCodeSchema,
  ProviderInstance,
  ProviderInstanceIdSchema,
  type ProviderDefinition,
  type ProviderSendInput,
  type ReadyProvider,
} from "./contract.js";
import { FakeProvider, signFakeCallback, type FakeOutcome } from "./fake.js";
import { makeMetaDefinition } from "./meta.js";
import { makePlayMobileDefinition, PlayMobileTemplateSchema } from "./play-mobile.js";
import { makeTelegramDefinition } from "./telegram.js";
import {
  HttpTransportError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from "./transport.js";

const encoder = new TextEncoder();
const decode = (body: Uint8Array): string => new TextDecoder().decode(body);
const jsonResponse = (status: number, body: Schema.Json): HttpResponse => ({
  status,
  headers: {},
  body: encoder.encode(JSON.stringify(body)),
});

const instanceId = Schema.decodeUnknownSync(ProviderInstanceIdSchema)("provider-1");
const locale = Schema.decodeUnknownSync(LocaleSchema)("en");
const attemptId = Schema.decodeUnknownSync(AttemptIdSchema)("018f47cb-5395-7c24-9d99-920f5538b168");
const sendInput = (template: Schema.Json = null): ProviderSendInput => ({
  operationId: Schema.decodeUnknownSync(OperationIdSchema)("018f47cb-5395-7c24-9d99-920f5538b167"),
  attemptId,
  recipient: Schema.decodeUnknownSync(NormalizedPhoneSchema)("+998901234567"),
  code: Schema.decodeUnknownSync(OtpCodeSchema)("012345"),
  remainingDeliveryMs: 60_000,
  expiresAt: Schema.decodeUnknownSync(IsoDateTimeSchema)("2000-01-01T00:00:00.000Z"),
  locale,
  template,
});

const build = <Configuration, Encoded>(
  definition: ProviderDefinition<Configuration, Encoded>,
  config: Configuration,
  templates: Readonly<Record<string, unknown>> = {},
): Effect.Effect<ReadyProvider, never> =>
  definition
    .make({
      instanceId,
      enabled: true,
      settingsFingerprint: "settings-v1",
      config,
      templates,
    })
    .pipe(
      (layer) => Effect.scoped(Layer.build(layer)),
      Effect.map((context) => Context.get(context, ProviderInstance)),
      Effect.orDie,
    );

const fakeConfig = (outcome: FakeOutcome) => ({
  outcome,
  callbackSecret: Redacted.make("callback-secret"),
});

it.effect("normalizes every consequential fake send outcome", () =>
  Effect.gen(function* () {
    const expectations = [
      ["recipient_unavailable", "RecipientUnavailable", "not_accepted"],
      ["invalid_recipient", "InvalidRecipient", "not_accepted"],
      ["throttled", "ProviderThrottled", "not_accepted"],
      ["configuration_rejected", "ProviderConfigurationRejected", "not_accepted"],
      ["temporary_rejected", "TemporaryProviderFailure", "not_accepted"],
      ["unknown", "UnknownProviderOutcome", "unknown"],
    ] as const;
    const accepted = yield* build(FakeProvider, fakeConfig("accepted"));
    expect(yield* accepted.send(sendInput())).toEqual({
      providerRequestId: `fake:${attemptId}`,
    });
    for (const [outcome, tag, acceptance] of expectations) {
      const provider = yield* build(FakeProvider, fakeConfig(outcome));
      const result = yield* Effect.result(provider.send(sendInput()));
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: tag, acceptance } });
    }
  }),
);

it.effect("keeps fake sends interruptible and authenticates callback batches", () =>
  Effect.gen(function* () {
    const provider = yield* build(FakeProvider, fakeConfig("never"));
    const fiber = yield* Effect.forkChild(provider.send(sendInput()));
    yield* Fiber.interrupt(fiber);
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);

    const body = encoder.encode(
      JSON.stringify({
        events: [
          {
            id: "event-1",
            correlationReference: "delivery-1",
            status: "delivered",
          },
        ],
      }),
    );
    const callback = provider.callback;
    expect(callback).toBeDefined();
    if (callback === undefined) return;
    const authenticated = yield* callback({
      body,
      method: "POST",
      path: "/callbacks/fake",
      query: {},
      headers: { "x-fake-signature": signFakeCallback("callback-secret", body) },
    });
    expect(authenticated).toMatchObject({
      _tag: "Events",
      events: [{ deduplicationKey: "event-1", status: "delivered" }],
    });
    const rejected = yield* Effect.result(
      callback({
        body,
        method: "POST",
        path: "/callbacks/fake",
        query: {},
        headers: { "x-fake-signature": "00".repeat(32) },
      }),
    );
    expect(rejected).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CallbackAuthenticationError", diagnosticCode: "invalid_signature" },
    });
  }),
);

it("rejects invalid provider and template configuration before use", () => {
  expect(
    Exit.isFailure(
      Schema.decodeUnknownExit(PlayMobileTemplateSchema)({ text: "x".repeat(153) + "{{code}}" }),
    ),
  ).toBe(true);
  expect(
    Exit.isFailure(Schema.decodeUnknownExit(FakeProvider.configSchema)({ outcome: "accepted" })),
  ).toBe(true);
  expect(
    Exit.isFailure(
      Schema.decodeUnknownExit(PlayMobileTemplateSchema)({
        text: "Codes {{code}} and {{other}}",
      }),
    ),
  ).toBe(true);
  expect(
    Exit.isFailure(
      Schema.decodeUnknownExit(makeTelegramDefinition().configSchema)({ apiToken: "" }),
    ),
  ).toBe(true);
  expect(
    Exit.isFailure(
      Schema.decodeUnknownExit(makeMetaDefinition().configSchema)({
        accessToken: "token",
        appSecret: "secret",
        verifyToken: "verify",
        phoneNumberId: "not-numeric",
        apiVersion: "latest",
      }),
    ),
  ).toBe(true);
  expect(
    Exit.isFailure(
      Schema.decodeUnknownExit(makePlayMobileDefinition().configSchema)({
        username: "user",
        password: "password",
        originator: "sender-name-too-long",
      }),
    ),
  ).toBe(true);
});

it.effect("does not retry an interrupted or failed provider transport", () =>
  Effect.gen(function* () {
    let calls = 0;
    const definition = makeTelegramDefinition({
      execute: () => {
        calls += 1;
        return Effect.fail(new HttpTransportError({ reason: "request_failed" }));
      },
    });
    const config = yield* Schema.decodeUnknownEffect(definition.configSchema)({
      apiToken: "telegram-secret",
    });
    const provider = yield* build(definition, config);
    const result = yield* Effect.result(provider.send(sendInput()));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "UnknownProviderOutcome", acceptance: "unknown" },
    });
    expect(calls).toBe(1);
  }),
);

it.effect("sends Telegram codes once and treats unclassified rejection as uncertain", () =>
  Effect.gen(function* () {
    const requests: HttpRequest[] = [];
    let response = jsonResponse(200, { ok: true, result: { request_id: "tg-request-1" } });
    const transport: HttpTransport = {
      execute: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return response;
        }),
    };
    const definition = makeTelegramDefinition(transport);
    const config = yield* Schema.decodeUnknownEffect(definition.configSchema)({
      apiToken: "telegram-secret",
      callbackUrl: "https://router.example/callbacks/telegram",
    });
    const provider = yield* build(definition, config);
    expect(yield* provider.send(sendInput())).toMatchObject({ providerRequestId: "tg-request-1" });
    expect(requests).toHaveLength(1);
    const sent = JSON.parse(decode(requests[0]?.body ?? new Uint8Array())) as unknown;
    expect(sent).toMatchObject({
      ttl: 60,
      phone_number: "+998901234567",
      code: "012345",
      payload: attemptId,
      callback_url: "https://router.example/callbacks/telegram",
    });

    response = jsonResponse(400, { ok: false, error: "SOME_NEW_ERROR" });
    const failure = yield* Effect.result(provider.send(sendInput()));
    expect(failure).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "UnknownProviderOutcome", acceptance: "unknown" },
    });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(failure)).not.toContain("012345");
    expect(JSON.stringify(failure)).not.toContain("telegram-secret");
  }),
);

it.effect("authenticates and normalizes Telegram delivery reports", () =>
  Effect.gen(function* () {
    const definition = makeTelegramDefinition({
      execute: () => Effect.fail(new HttpTransportError({ reason: "request_failed" })),
    });
    const config = yield* Schema.decodeUnknownEffect(definition.configSchema)({
      apiToken: "telegram-secret",
    });
    const provider = yield* build(definition, config);
    const callback = provider.callback;
    if (callback === undefined) return;
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const body = encoder.encode(
      JSON.stringify({
        request_id: "tg-request-1",
        payload: "delivery-1",
        delivery_status: { status: "delivered", updated_at: Number(timestamp) },
      }),
    );
    const key = createHash("sha256").update("telegram-secret", "utf8").digest();
    const signature = createHmac("sha256", key)
      .update(timestamp)
      .update("\n")
      .update(body)
      .digest("hex");
    const result = yield* callback({
      body,
      method: "POST",
      path: "/callbacks/telegram",
      query: {},
      headers: { "x-request-timestamp": timestamp, "x-request-signature": signature },
    });
    expect(result).toMatchObject({
      _tag: "Events",
      events: [{ correlationReference: "delivery-1", status: "delivered" }],
    });
    const invalidBody = encoder.encode(
      JSON.stringify({
        request_id: "invalid-time",
        delivery_status: { status: "delivered", updated_at: 8640000000001 },
      }),
    );
    const invalidSignature = createHmac("sha256", key)
      .update(timestamp)
      .update("\n")
      .update(invalidBody)
      .digest("hex");
    const invalid = yield* callback({
      body: invalidBody,
      method: "POST",
      path: "/callbacks/telegram",
      query: {},
      headers: { "x-request-timestamp": timestamp, "x-request-signature": invalidSignature },
    }).pipe(Effect.result);
    expect(invalid).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CallbackFormatError", diagnosticCode: "invalid_body" },
    });
  }),
);

it.effect("maps one Meta authentication template send and verifies both callback flows", () =>
  Effect.gen(function* () {
    const requests: HttpRequest[] = [];
    const transport: HttpTransport = {
      execute: (request) =>
        Effect.sync(() => {
          requests.push(request);
          return jsonResponse(200, { messages: [{ id: "wamid.1" }] });
        }),
    };
    const definition = makeMetaDefinition(transport);
    const config = yield* Schema.decodeUnknownEffect(definition.configSchema)({
      accessToken: "meta-token",
      appSecret: "meta-app-secret",
      verifyToken: "meta-verify",
      phoneNumberId: "1234",
      apiVersion: "v23.0",
    });
    const template = { name: "login_code", languageCode: "en_US", codeButtonIndex: 0 };
    const provider = yield* build(definition, config, { en: template });
    const resolved = yield* provider.resolveTemplate([locale]);
    expect(yield* provider.send(sendInput(resolved.template))).toMatchObject({
      providerRequestId: "wamid.1",
    });
    expect(requests).toHaveLength(1);
    const sent = JSON.parse(decode(requests[0]?.body ?? new Uint8Array())) as unknown;
    expect(sent).toMatchObject({
      to: "998901234567",
      template: {
        name: "login_code",
        components: [
          { type: "body", parameters: [{ text: "012345" }] },
          { type: "button", index: "0", parameters: [{ text: "012345" }] },
        ],
      },
    });
    const callback = provider.callback;
    if (callback === undefined) return;
    const handshake = yield* callback({
      body: new Uint8Array(),
      method: "GET",
      path: "/callbacks/meta",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "meta-verify",
        "hub.challenge": "challenge-value",
      },
      headers: {},
    });
    expect(handshake).toMatchObject({ _tag: "Handshake", status: 200 });
    const callbackBody = encoder.encode(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  statuses: [{ id: "wamid.1", status: "delivered", timestamp: "1710000000" }],
                },
              },
            ],
          },
        ],
      }),
    );
    const callbackSignature = createHmac("sha256", "meta-app-secret")
      .update(callbackBody)
      .digest("hex");
    const events = yield* callback({
      body: callbackBody,
      method: "POST",
      path: "/callbacks/meta",
      query: {},
      headers: { "x-hub-signature-256": `sha256=${callbackSignature}` },
    });
    expect(events).toMatchObject({
      _tag: "Events",
      events: [{ correlationReference: "wamid.1", status: "delivered" }],
    });
  }),
);

it.effect(
  "renders a single-segment Play Mobile request and preserves internal-error uncertainty",
  () =>
    Effect.gen(function* () {
      const requests: HttpRequest[] = [];
      let response: HttpResponse = {
        status: 200,
        headers: {},
        body: encoder.encode("Request is received"),
      };
      const transport: HttpTransport = {
        execute: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return response;
          }),
      };
      const definition = makePlayMobileDefinition(transport);
      const config = yield* Schema.decodeUnknownEffect(definition.configSchema)({
        username: "play-user",
        password: "play-password",
        originator: "3700",
      });
      const provider = yield* build(definition, config, { en: { text: "Code: {{code}}" } });
      const resolved = yield* provider.resolveTemplate([locale]);
      const accepted = yield* provider.send(sendInput(resolved.template));
      expect(accepted.providerRequestId).toMatch(/^otp[0-9a-f]{17}$/u);
      const sent = JSON.parse(decode(requests[0]?.body ?? new Uint8Array())) as unknown;
      expect(sent).toMatchObject({
        messages: [
          {
            recipient: "998901234567",
            "message-id": accepted.providerRequestId,
            sms: { ttl: 60, originator: "3700", content: { text: "Code: 012345" } },
          },
        ],
      });
      response = jsonResponse(400, { error_code: "100", error_description: "secret text" });
      const failure = yield* Effect.result(provider.send(sendInput(resolved.template)));
      expect(failure).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "UnknownProviderOutcome",
          acceptance: "unknown",
          diagnosticCode: "play_mobile_internal_error",
        },
      });
      expect(JSON.stringify(failure)).not.toContain("secret text");
      expect(requests).toHaveLength(2);
    }),
);
