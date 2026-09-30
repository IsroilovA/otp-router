import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { Principals } from "../config/config.js";
import { ApplicationAuth, RequestContext, AdminAuth, AdminContext } from "./contracts.js";
import { errorMessages } from "./errors.js";

const digest = (key: string): Buffer => createHash("sha256").update(key, "utf8").digest();

export const makeAuthLayer = (principals: typeof Principals.Type) => {
  const expected = principals.flatMap((principal) =>
    principal.keys.map((key) => ({ digest: digest(key), principal })),
  );
  return Layer.succeed(ApplicationAuth, {
    bearer: (httpEffect, { credential }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers["authorization"] ?? "";
        const token = Redacted.value(credential);
        const supplied = digest(token);
        const projectId = /^\/v1\/projects\/([a-zA-Z0-9_-]+)(?:\/|$)/u.exec(request.url)?.[1];
        let principal: (typeof Principals.Type)[number] | undefined;
        for (const candidate of expected)
          if (timingSafeEqual(supplied, candidate.digest)) principal = candidate.principal;
        const requestId = randomUUID();
        if (
          !authorization.startsWith("Bearer ") ||
          authorization.length !== token.length + 7 ||
          principal === undefined ||
          projectId === undefined
        )
          return yield* Effect.fail({
            error: {
              code: "unauthorized" as const,
              message: errorMessages.unauthorized,
              requestId,
            },
          });
        return yield* Effect.provideService(httpEffect, RequestContext, {
          requestId,
          projectId,
          principalId: principal.id,
        });
      }),
  });
};
export const makeAdminAuth = (administrators: typeof Principals.Type) => {
  const expected = Schema.decodeUnknownSync(Principals)(administrators).flatMap((actor) =>
    actor.keys.map((key) => ({ actorId: actor.id, digest: digest(key) })),
  );
  return Layer.succeed(AdminAuth, {
    bearer: (effect, { credential }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const token = Redacted.value(credential);
        const supplied = digest(token);
        let actorId: string | undefined;
        for (const candidate of expected)
          if (timingSafeEqual(supplied, candidate.digest)) actorId = candidate.actorId;
        const requestId = randomUUID();
        if (actorId === undefined || request.headers["authorization"] !== `Bearer ${token}`)
          return yield* Effect.fail({
            error: {
              code: "unauthorized" as const,
              message: errorMessages.unauthorized,
              requestId,
            },
          });
        return yield* Effect.provideService(effect, AdminContext, { actorId, requestId });
      }),
  });
};
