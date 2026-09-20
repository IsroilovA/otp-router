import { Data, Effect } from "effect";

export interface HttpRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export class HttpTransportError extends Data.TaggedError("HttpTransportError")<{
  readonly reason: "request_failed" | "response_failed" | "response_too_large";
}> {}

export interface HttpTransport {
  readonly execute: (request: HttpRequest) => Effect.Effect<HttpResponse, HttpTransportError>;
}

const toHeaders = (headers: Headers): Readonly<Record<string, string>> => {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value;
  });
  return output;
};

const responseBodyLimit = 256 * 1024;
const readResponseBody = async (response: Response): Promise<Uint8Array> => {
  if (response.body === null) return new Uint8Array();
  if (Number(response.headers.get("content-length")) > responseBodyLimit) {
    await response.body.cancel();
    throw new HttpTransportError({ reason: "response_too_large" });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > responseBodyLimit) {
        await reader.cancel();
        throw new HttpTransportError({ reason: "response_too_large" });
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export const fetchTransport: HttpTransport = {
  execute: (request) =>
    Effect.callback<HttpResponse, HttpTransportError>((resume, signal) => {
      fetch(request.url, {
        method: request.method,
        redirect: "error",
        headers: request.headers,
        body: Uint8Array.from(request.body),
        signal,
      }).then(
        (response) => {
          readResponseBody(response).then(
            (body) =>
              resume(
                Effect.succeed({
                  status: response.status,
                  headers: toHeaders(response.headers),
                  body,
                }),
              ),
            (error: unknown) =>
              resume(
                Effect.fail(
                  error instanceof HttpTransportError
                    ? error
                    : new HttpTransportError({ reason: "response_failed" }),
                ),
              ),
          );
        },
        () => resume(Effect.fail(new HttpTransportError({ reason: "request_failed" }))),
      );
    }),
};
