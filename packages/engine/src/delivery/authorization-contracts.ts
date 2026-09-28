import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";
import { Identifier } from "./input.js";

const Timestamp = Schema.String.check(
  Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
);
const Identity = {
  deploymentId: Schema.String,
  projectId: Identifier,
  attemptId: Schema.String.check(Schema.isUUID()),
};
export const AuthorizationRequest = Schema.Struct({
  ...Identity,
  operationId: Schema.String.check(Schema.isUUID()),
  providerInstanceId: Identifier,
  channel: Identifier,
  reason: Schema.Literals(["initial", "fallback", "resend", "next", "select"]),
  dispatchDeadline: Timestamp,
});
export type AuthorizationRequest = typeof AuthorizationRequest.Type;
export const AuthorizationDecision = Schema.Union([
  Schema.Struct({
    ...Identity,
    decision: Schema.Literal("approved"),
    reservationId: Identifier,
    validUntil: Timestamp,
  }),
  Schema.Struct({ ...Identity, decision: Schema.Literal("pending"), retryAt: Timestamp }),
  Schema.Struct({
    ...Identity,
    decision: Schema.Literal("denied"),
    scope: Schema.Literal("route"),
  }),
  Schema.Struct({
    ...Identity,
    decision: Schema.Literal("denied"),
    scope: Schema.Literal("project"),
    retryAt: Timestamp,
  }),
]);
export type AuthorizationDecision = typeof AuthorizationDecision.Type;
export class AuthorizationUnavailable extends Data.TaggedError("AuthorizationUnavailable")<{}> {}
export class SendAuthorizer extends Context.Service<
  SendAuthorizer,
  {
    readonly reserve: (
      request: AuthorizationRequest,
    ) => Effect.Effect<AuthorizationDecision, AuthorizationUnavailable>;
  }
>()("otp-router/SendAuthorizer") {}

const readDecision = async (response: Response): Promise<unknown> => {
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw new AuthorizationUnavailable();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "",
    size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new AuthorizationUnavailable();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
};

const Endpoint = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  }),
);
// The authority must persist an idempotent reservation before returning approval.
// Credentials and URLs are trusted deployment configuration, never request input.
export const httpSendAuthorizer = (options: {
  readonly url: string;
  readonly token: Redacted.Redacted<string>;
}) =>
  Layer.effect(
    SendAuthorizer,
    Effect.gen(function* () {
      const endpoint = yield* Schema.decodeUnknownEffect(Endpoint)(options.url).pipe(
        Effect.mapError(() => new AuthorizationUnavailable()),
      );
      return {
        reserve: (request) =>
          Effect.tryPromise({
            try: async (signal) => {
              const url = new URL(endpoint);
              url.pathname = `${url.pathname.replace(/\/$/u, "")}/${request.attemptId}`;
              return readDecision(
                await fetch(url, {
                  method: "PUT",
                  redirect: "error",
                  signal,
                  headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${Redacted.value(options.token)}`,
                  },
                  body: JSON.stringify(request),
                }),
              );
            },
            catch: () => new AuthorizationUnavailable(),
          }).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(AuthorizationDecision, { onExcessProperty: "error" }),
            ),
            Effect.timeout("5 seconds"),
            Effect.mapError(() => new AuthorizationUnavailable()),
          ),
      };
    }),
  );
