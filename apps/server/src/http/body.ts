import { Data, Effect, type Schema, Stream } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { decodeJson } from "./json.js";
import { errorResponse } from "./errors.js";

const APPLICATION_BODY_LIMIT = 16 * 1024;

export class BodyTooLarge extends Data.TaggedError("BodyTooLarge") {}
export class InvalidRequest extends Data.TaggedError("InvalidRequest") {}

interface BodyState {
  readonly size: number;
  readonly chunks: Array<Uint8Array>;
}

export const readBody = (
  request: HttpServerRequest.HttpServerRequest,
  limit: number,
): Effect.Effect<Uint8Array, BodyTooLarge | InvalidRequest> =>
  request.stream.pipe(
    Stream.runFoldEffect<BodyState, Uint8Array, BodyTooLarge, never>(
      () => ({ size: 0, chunks: [] }),
      (state, chunk) => {
        const size = state.size + chunk.byteLength;
        if (size > limit) return Effect.fail(new BodyTooLarge());
        state.chunks.push(chunk);
        return Effect.succeed({ size, chunks: state.chunks });
      },
    ),
    Effect.map((state) => {
      const body = new Uint8Array(state.size);
      let offset = 0;
      for (const chunk of state.chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    }),
    Effect.mapError((error) => (error instanceof BodyTooLarge ? error : new InvalidRequest())),
  );

const mediaType = (request: HttpServerRequest.HttpServerRequest): string =>
  (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";

const validateApplicationHeaders = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<void, BodyTooLarge | InvalidRequest> => {
  const length = request.headers["content-length"];
  if (length !== undefined) {
    if (!/^[0-9]+$/.test(length)) return Effect.fail(new InvalidRequest());
    if (Number(length) > APPLICATION_BODY_LIMIT) return Effect.fail(new BodyTooLarge());
  }
  if (mediaType(request) !== "application/json") return Effect.fail(new InvalidRequest());
  const encoding = request.headers["content-encoding"]?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "identity") return Effect.fail(new InvalidRequest());
  return Effect.void;
};

const decodeUtf8 = (body: Uint8Array): Effect.Effect<string, InvalidRequest> =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
    catch: () => new InvalidRequest(),
  });

export const readApplicationJson = <A, I>(
  request: HttpServerRequest.HttpServerRequest,
  schema: Schema.Codec<A, I>,
): Effect.Effect<A, BodyTooLarge | InvalidRequest> =>
  validateApplicationHeaders(request).pipe(
    Effect.andThen(readBody(request, APPLICATION_BODY_LIMIT)),
    Effect.flatMap(decodeUtf8),
    Effect.flatMap(decodeJson(schema)),
    Effect.mapError((error) => (error instanceof BodyTooLarge ? error : new InvalidRequest())),
  );
export const transportFailure = (error: BodyTooLarge | InvalidRequest, requestId: string) =>
  errorResponse(error instanceof BodyTooLarge ? "request_too_large" : "invalid_request", requestId);
