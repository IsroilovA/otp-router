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
  readonly reason: "request_failed" | "response_failed";
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

export const fetchTransport: HttpTransport = {
  execute: (request) =>
    Effect.async<HttpResponse, HttpTransportError>((resume) => {
      const controller = new AbortController();
      fetch(request.url, {
        method: request.method,
        redirect: "error",
        headers: request.headers,
        body: Uint8Array.from(request.body),
        signal: controller.signal,
      }).then(
        (response) => {
          response.arrayBuffer().then(
            (body) =>
              resume(
                Effect.succeed({
                  status: response.status,
                  headers: toHeaders(response.headers),
                  body: new Uint8Array(body),
                }),
              ),
            () => resume(Effect.fail(new HttpTransportError({ reason: "response_failed" }))),
          );
        },
        () => resume(Effect.fail(new HttpTransportError({ reason: "request_failed" }))),
      );
      return Effect.sync(() => controller.abort());
    }),
};
