import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

export const WebhookGroup = HttpApiGroup.make("providerCallbacks").add(
  HttpApiEndpoint.get("providerHandshake", "/webhooks/:providerInstanceId", {
    params: { providerInstanceId: Schema.String },
    success: Schema.String.pipe(HttpApiSchema.asText()),
    error: [
      HttpApiSchema.Empty(400),
      HttpApiSchema.Empty(401),
      HttpApiSchema.Empty(404),
      HttpApiSchema.Empty(503),
    ],
  }),
  HttpApiEndpoint.post("providerCallback", "/webhooks/:providerInstanceId", {
    params: { providerInstanceId: Schema.String },
    payload: Schema.Uint8Array.pipe(
      HttpApiSchema.asUint8Array({ contentType: "application/json" }),
    ),
    success: HttpApiSchema.Empty(200),
    error: [
      HttpApiSchema.Empty(400),
      HttpApiSchema.Empty(401),
      HttpApiSchema.Empty(404),
      HttpApiSchema.Empty(413),
      HttpApiSchema.Empty(503),
    ],
  }),
);
