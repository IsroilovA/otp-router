import { createHash, createHmac } from "node:crypto";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Schema } from "effect";
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
  type ProviderMakeOptions,
  type ProviderSendInput,
  type ReadyProvider,
} from "./contract.js";
import { defineProvider } from "./define.js";
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

const build = (
  definition: ProviderDefinition,
  config: Omit<ProviderMakeOptions, "instanceId" | "revision" | "templates">,
  templates: Readonly<Record<string, unknown>> = {},
): Effect.Effect<ReadyProvider, never> =>
  definition
    .make({
      instanceId,
      revision: "settings-v1",
      ...config,
      templates,
    })
    .pipe(
      (layer) => Effect.scoped(Layer.build(layer)),
      Effect.map((context) => Context.get(context, ProviderInstance)),
      Effect.orDie,
    );

const fakeConfig = (outcome: FakeOutcome) => ({
  identity: { account: "fake" },
  secrets: {},
  execution: { outcome },
  callbackSecrets: { callbackSecret: "callback-secret" },
});

it.effect("normalizes every consequential fake send outcome", () =>
  Effect.gen(function* () {
    const expectations = [
      ["recipient_unavailable", "recipient_unavailable"],
      ["invalid_recipient", "invalid_recipient"],
      ["throttled", "throttled"],
      ["configuration_rejected", "configuration"],
      ["temporary_rejected", "temporary"],
    ] as const;
    const accepted = yield* build(FakeProvider, fakeConfig("accepted"));
    expect(yield* accepted.send(sendInput())).toEqual({
      providerRequestId: `fake:${attemptId}`,
    });
    const uncertain = yield* build(FakeProvider, fakeConfig("unknown"));
    expect(yield* Effect.result(uncertain.send(sendInput()))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderUncertain" },
    });
    for (const [outcome, reason] of expectations) {
      const provider = yield* build(FakeProvider, fakeConfig(outcome));
      const result = yield* Effect.result(provider.send(sendInput()));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProviderRejected", reason },
      });
    }
  }),
);

it.effect("authenticates fake callback batches", () =>
  Effect.gen(function* () {
    const provider = yield* build(FakeProvider, fakeConfig("accepted"));

    const body = encoder.encode(
      JSON.stringify({
        events: [
          {
            id: "event-1",
            correlationReference: { _tag: "Attempt", attemptId },
            status: "delivered",
          },
        ],
      }),
    );
    const callback = provider.callback;
    if (callback === undefined) throw new Error("Expected provider callback");
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
    Exit.isFailure(
      Schema.decodeUnknownExit(FakeProvider.callbackSecretsSchema)({ outcome: "accepted" }),
    ),
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
      Schema.decodeUnknownExit(makeTelegramDefinition().secretsSchema)({ apiToken: "" }),
    ),
  ).toBe(true);
  expect(
    Exit.isFailure(
      Schema.decodeUnknownExit(makeMetaDefinition().executionSchema)({
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
      Schema.decodeUnknownExit(makePlayMobileDefinition().executionSchema)({
        username: "user",
        password: "password",
        originator: "sender-name-too-long",
      }),
    ),
  ).toBe(true);
});

it.effect("does not retry a failed provider transport", () =>
  Effect.gen(function* () {
    let calls = 0;
    const definition = makeTelegramDefinition({
      execute: () => {
        calls += 1;
        return Effect.fail(new HttpTransportError({ reason: "request_failed" }));
      },
    });
    const config = {
      identity: { account: "telegram" },
      secrets: { apiToken: "telegram-secret" },
      callbackSecrets: { apiToken: "telegram-secret" },
      execution: {},
    };
    const provider = yield* build(definition, config);
    const result = yield* Effect.result(
      provider.send(sendInput((yield* provider.resolveTemplate([locale])).template)),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderUncertain" },
    });
    expect(calls).toBe(1);
  }),
);

it.effect(
  "sends Telegram codes once and distinguishes API rejection from uncertain acceptance",
  () =>
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
      const config = {
        identity: { account: "telegram" },
        secrets: { apiToken: "telegram-secret" },
        callbackSecrets: { apiToken: "telegram-secret" },
        execution: { callbackUrl: "https://router.example/callbacks/telegram" },
      };
      const provider = yield* build(definition, config);
      expect(
        yield* provider.send(sendInput((yield* provider.resolveTemplate([locale])).template)),
      ).toMatchObject({ providerRequestId: "tg-request-1" });
      expect(requests).toHaveLength(1);
      const sent = JSON.parse(decode(requests[0]?.body ?? new Uint8Array())) as unknown;
      expect(sent).toMatchObject({
        ttl: 60,
        phone_number: "+998901234567",
        code: "012345",
        payload: attemptId,
        callback_url: "https://router.example/callbacks/telegram",
      });

      const request = sendInput((yield* provider.resolveTemplate([locale])).template);
      const rejections = [
        [200, "PHONE_NUMBER_NOT_FOUND", "recipient_unavailable", "telegram_recipient_unavailable"],
        [
          400,
          "PHONE_NUMBER_NOT_AVAILABLE",
          "recipient_unavailable",
          "telegram_recipient_unavailable",
        ],
        [200, "SOME_NEW_ERROR", "unspecified", "telegram_rejected"],
        [400, "SOME_NEW_ERROR", "unspecified", "telegram_rejected"],
        [400, "PHONE_NUMBER_INVALID", "unspecified", "telegram_rejected"],
        [401, "ACCESS_TOKEN_INVALID", "configuration", "access_token_invalid"],
      ] as const;
      for (const [status, error, reason, diagnosticCode] of rejections) {
        response = jsonResponse(status, { ok: false, error });
        const failure = yield* Effect.result(provider.send(request));
        expect(failure).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProviderRejected", reason, diagnosticCode },
        });
        expect(JSON.stringify(failure)).not.toContain(error);
        expect(JSON.stringify(failure)).not.toContain("012345");
        expect(JSON.stringify(failure)).not.toContain("telegram-secret");
      }
      // An API-shaped body cannot make a timeout, server failure, or existing send safe to repeat.
      const uncertainResponses = [
        jsonResponse(500, { ok: false, error: "SOME_NEW_ERROR" }),
        jsonResponse(503, { ok: false, error: "PHONE_NUMBER_NOT_AVAILABLE" }),
        jsonResponse(408, { ok: false, error: "SOME_NEW_ERROR" }),
        jsonResponse(200, { ok: false, error: "MESSAGE_ALREADY_SENT" }),
        jsonResponse(400, { ok: false, error: "MESSAGE_ALREADY_SENT" }),
        jsonResponse(400, { ok: true, result: { request_id: "contradictory" } }),
        jsonResponse(400, { error: "PHONE_NUMBER_NOT_FOUND" }),
        jsonResponse(200, { ok: false, error: "" }),
        { status: 502, headers: {}, body: encoder.encode("upstream unavailable") },
      ];
      for (const uncertainResponse of uncertainResponses) {
        response = uncertainResponse;
        expect(yield* Effect.result(provider.send(request))).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProviderUncertain" },
        });
      }
      expect(requests).toHaveLength(1 + rejections.length + uncertainResponses.length);
    }),
);

it.effect("authenticates and normalizes Telegram delivery reports", () =>
  Effect.gen(function* () {
    const definition = makeTelegramDefinition({
      execute: () => Effect.fail(new HttpTransportError({ reason: "request_failed" })),
    });
    const config = {
      identity: { account: "telegram" },
      secrets: { apiToken: "telegram-secret" },
      callbackSecrets: { apiToken: "telegram-secret" },
      execution: {},
    };
    const provider = yield* build(definition, config);
    const callback = provider.callback;
    if (callback === undefined) throw new Error("Expected provider callback");
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const body = encoder.encode(
      JSON.stringify({
        request_id: "tg-request-1",
        payload: attemptId,
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
      events: [{ correlationReference: { _tag: "Attempt", attemptId }, status: "delivered" }],
    });
    for (const malformed of [signature.slice(1), `${signature}0`, `${signature}00`]) {
      expect(
        yield* callback({
          body,
          method: "POST",
          path: "/callbacks/telegram",
          query: {},
          headers: { "x-request-timestamp": timestamp, "x-request-signature": malformed },
        }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "CallbackAuthenticationError", diagnosticCode: "invalid_signature" },
      });
    }
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
    const config = {
      identity: { businessAccountId: "business" },
      secrets: { accessToken: "meta-token" },
      callbackSecrets: { appSecret: "meta-app-secret", verifyToken: "meta-verify" },
      execution: { phoneNumberId: "1234", apiVersion: "v23.0" },
    };
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
      biz_opaque_callback_data: attemptId,
      template: {
        name: "login_code",
        components: [
          { type: "body", parameters: [{ text: "012345" }] },
          { type: "button", index: "0", parameters: [{ text: "012345" }] },
        ],
      },
    });
    const callback = provider.callback;
    if (callback === undefined) throw new Error("Expected provider callback");
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
    const inbound = {
      metadata: { phone_number_id: "1234" },
      messages: [{ id: "wamid.inbound", type: "text", text: { body: "hello" } }],
    };
    const delivered = {
      metadata: { phone_number_id: "1234" },
      statuses: [{ id: "wamid.1", status: "delivered", timestamp: "1710000000" }],
    };
    const notification = (
      values: readonly unknown[],
      authenticated = true,
      businessId = "business",
    ) => {
      const body = encoder.encode(
        JSON.stringify({
          object: "whatsapp_business_account",
          entry: [
            { id: businessId, changes: values.map((value) => ({ field: "messages", value })) },
          ],
        }),
      );
      const signature = createHmac("sha256", "meta-app-secret").update(body).digest("hex");
      return callback({
        body,
        method: "POST",
        path: "/callbacks/meta",
        query: {},
        headers: { "x-hub-signature-256": authenticated ? `sha256=${signature}` : "invalid" },
      });
    };
    expect(yield* notification([delivered, inbound])).toMatchObject({
      _tag: "Events",
      events: [
        {
          correlationReference: { _tag: "ProviderRequest", providerRequestId: "wamid.1" },
          status: "delivered",
        },
      ],
    });
    expect(
      yield* notification([delivered], true, "different-account").pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "CallbackAuthenticationError" } });
    expect(
      yield* notification([
        { ...delivered, metadata: { phone_number_id: "different-sender" } },
      ]).pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "CallbackAuthenticationError" } });
    expect(yield* notification([inbound])).toEqual({ _tag: "Events", events: [] });
    expect(yield* notification([inbound], false).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CallbackAuthenticationError" },
    });
    expect(
      yield* notification([inbound, { statuses: [{ id: "wamid.bad" }] }]).pipe(Effect.result),
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CallbackFormatError" },
    });
  }),
);

it.effect(
  "renders Play Mobile requests and distinguishes request rejection from internal uncertainty",
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
      const config = {
        identity: { username: "play-user" },
        secrets: { password: "play-password" },
        callbackSecrets: {},
        execution: { originator: "3700" },
      };
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
          _tag: "ProviderUncertain",
          diagnosticCode: "play_mobile_internal_error",
        },
      });
      expect(JSON.stringify(failure)).not.toContain("secret text");
      for (const errorCode of ["202", "204"]) {
        response = jsonResponse(400, {
          error_code: errorCode,
          error_description: "secret request details",
        });
        const rejected = yield* Effect.result(provider.send(sendInput(resolved.template)));
        expect(rejected).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ProviderRejected",
            reason: "configuration",
            diagnosticCode: "request_configuration_rejected",
          },
        });
        expect(JSON.stringify(rejected)).not.toContain("secret request details");
      }
      expect(requests).toHaveLength(4);
    }),
);

it.effect("caps Telegram delivery TTL by saved settings and remaining lifetime", () =>
  Effect.gen(function* () {
    const bodies: unknown[] = [];
    const definition = makeTelegramDefinition({
      execute: (request) =>
        Effect.sync(() => {
          bodies.push(JSON.parse(decode(request.body)) as unknown);
          return jsonResponse(200, { ok: true, result: { request_id: "bounded-ttl" } });
        }),
    });
    const config = {
      identity: { account: "telegram" },
      secrets: { apiToken: "token" },
      callbackSecrets: { apiToken: "token" },
      execution: { deliveryTtlSeconds: 45 },
    };
    const provider = yield* build(definition, config);
    const saved = yield* provider.resolveTemplate([locale]);
    const changed = yield* build(definition, { ...config, execution: { deliveryTtlSeconds: 90 } });
    yield* changed.send({ ...sendInput(saved.template), remainingDeliveryMs: 300_000 });
    yield* changed.send({ ...sendInput(saved.template), remainingDeliveryMs: 34_900 });
    const expired = yield* Effect.result(
      changed.send({ ...sendInput(saved.template), remainingDeliveryMs: 29_999 }),
    );
    expect(bodies).toMatchObject([{ ttl: 45 }, { ttl: 34 }]);
    expect(expired).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderRejected", diagnosticCode: "delivery_window_too_short" },
    });
    for (const ttl of [29, 3_601, Number.NaN]) {
      expect(
        Exit.isFailure(
          Schema.decodeUnknownExit(definition.executionSchema)({
            apiToken: "token",
            deliveryTtlSeconds: ttl,
          }),
        ),
      ).toBe(true);
    }
  }),
);

it.effect("reconciles Meta lost responses with authenticated echoed attempt references", () =>
  Effect.gen(function* () {
    const requests: HttpRequest[] = [];
    const definition = makeMetaDefinition({
      execute: (request) => {
        requests.push(request);
        return Effect.fail(new HttpTransportError({ reason: "request_failed" }));
      },
    });
    const config = {
      identity: { businessAccountId: "business" },
      secrets: { accessToken: "token" },
      callbackSecrets: { appSecret: "secret", verifyToken: "verify" },
      execution: { phoneNumberId: "123", apiVersion: "v23.0" },
    };
    const template = { name: "auth", languageCode: "en", codeButtonIndex: 0 };
    const provider = yield* build(definition, config, { en: template });
    expect(yield* Effect.result(provider.send(sendInput(template)))).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderUncertain" },
    });
    expect(requests).toHaveLength(1);
    const sent = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ biz_opaque_callback_data: AttemptIdSchema }),
    )(JSON.parse(decode(requests[0]?.body ?? new Uint8Array())) as unknown);
    expect(sent.biz_opaque_callback_data).toBe(attemptId);
    const callback = provider.callback;
    if (callback === undefined) return yield* Effect.die("Meta callback missing");
    for (const status of ["delivered", "failed"]) {
      const body = encoder.encode(
        JSON.stringify({
          object: "whatsapp_business_account",
          entry: [
            {
              id: "business",
              changes: [
                {
                  field: "messages",
                  value: {
                    metadata: { phone_number_id: "123" },
                    statuses: [
                      {
                        id: "wamid.lost",
                        status,
                        timestamp: "1710000000",
                        biz_opaque_callback_data: sent.biz_opaque_callback_data,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );
      const input = {
        body,
        method: "POST",
        path: "/callbacks/meta",
        query: {},
        headers: {
          "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`,
        },
      };
      expect(yield* callback(input)).toMatchObject({
        _tag: "Events",
        events: [
          {
            correlationReference: { _tag: "Attempt", attemptId },
            providerRequestId: "wamid.lost",
            status,
          },
        ],
      });
      expect(
        yield* Effect.result(
          callback({
            ...input,
            body: encoder.encode(
              decode(body).replace(attemptId, "018f47cb-5395-7c24-9d99-920f5538b169"),
            ),
          }),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "CallbackAuthenticationError" } });
    }
    expect(requests).toHaveLength(1);
  }),
);

it.effect("maps documented Meta rejections but preserves internal and unknown uncertainty", () =>
  Effect.gen(function* () {
    let code = 131026;
    let calls = 0;
    const definition = makeMetaDefinition({
      execute: () =>
        Effect.sync(() => {
          calls += 1;
          return jsonResponse(400, { error: { code, message: "sensitive provider details" } });
        }),
    });
    const config = {
      identity: { businessAccountId: "business" },
      secrets: { accessToken: "token" },
      callbackSecrets: { appSecret: "secret", verifyToken: "verify" },
      execution: { phoneNumberId: "123", apiVersion: "v23.0" },
    };
    const template = { name: "auth", languageCode: "en", codeButtonIndex: 0 };
    const provider = yield* build(definition, config, { en: template });
    for (const [errorCode, reason] of [
      [131026, "recipient_unavailable"],
      [190, "configuration"],
      [131008, "configuration"],
      [132001, "configuration"],
      [130429, "throttled"],
    ] as const) {
      code = errorCode;
      const result = yield* Effect.result(provider.send(sendInput(template)));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProviderRejected", reason },
      });
      expect(JSON.stringify(result)).not.toContain("sensitive provider details");
    }
    for (const unknown of [131000, 999999]) {
      code = unknown;
      expect(yield* Effect.result(provider.send(sendInput(template)))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProviderUncertain" },
      });
    }
    expect(calls).toBe(7);
  }),
);

it.effect("validates custom adapter construction through the shared definition helper", () =>
  Effect.gen(function* () {
    const invalid = defineProvider({
      ...FakeProvider,
      constraints: { minCodeLength: 6, maxCodeLength: 8, minDeliveryWindowMs: Number.NaN },
      templateSchema: null,
      create: () => ({ send: () => Effect.succeed({}) }),
    });
    const outcome = yield* Effect.result(
      Effect.scoped(
        Layer.build(
          invalid.make({
            instanceId,
            revision: "v1",
            ...fakeConfig("accepted"),
            templates: {},
          }),
        ),
      ),
    );
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderConfigurationError", diagnosticCode: "invalid_constraints" },
    });
  }),
);
