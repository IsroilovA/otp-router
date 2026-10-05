import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import type { DomainError } from "@otp-router/engine/challenges";
import { AdminContext } from "./contracts.js";
import { errorResponse } from "./errors.js";

export const adminRead = <A extends object>(effect: Effect.Effect<A, DomainError>) =>
  Effect.gen(function* () {
    const { requestId } = yield* AdminContext;
    return yield* effect.pipe(
      Effect.map((body) =>
        HttpServerResponse.jsonUnsafe(body, {
          headers: {
            "x-request-id": requestId,
            ...("revision" in body ? { etag: `"${String(body.revision)}"` } : {}),
          },
        }),
      ),
      Effect.catchTag("DomainError", (error) => errorResponse(error.code, requestId)),
    );
  });
