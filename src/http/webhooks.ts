import type { Headers } from "effect/unstable/http";
import { Context, Data, type Effect } from "effect";

export type WebhookQuery = Readonly<Record<string, string | ReadonlyArray<string>>>;

export interface WebhookHandshakeInput {
  readonly providerInstanceId: string;
  readonly headers: Headers.Headers;
  readonly query: WebhookQuery;
}

export interface WebhookHandshakeReply {
  readonly status: number;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface WebhookIngestInput {
  readonly providerInstanceId: string;
  readonly headers: Headers.Headers;
  readonly query: WebhookQuery;
  readonly body: Uint8Array;
}

export type WebhookErrorCode =
  | "invalid"
  | "unauthorized"
  | "unknown_instance"
  | "temporarily_unavailable";

export class WebhookError extends Data.TaggedError("WebhookError")<{
  readonly code: WebhookErrorCode;
}> {}

export class WebhookHandler extends Context.Service<
  WebhookHandler,
  {
    readonly handshake: (
      input: WebhookHandshakeInput,
    ) => Effect.Effect<WebhookHandshakeReply, WebhookError>;
    readonly ingest: (input: WebhookIngestInput) => Effect.Effect<void, WebhookError>;
  }
>()("otp-router/http/WebhookHandler") {}

export const statusForWebhookError = (code: WebhookErrorCode): number => {
  switch (code) {
    case "invalid":
      return 400;
    case "unauthorized":
      return 401;
    case "unknown_instance":
      return 404;
    case "temporarily_unavailable":
      return 503;
  }
};
