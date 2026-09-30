import { Schema } from "effect";
import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import { ChallengeEvent } from "@otp-router/engine/challenges";
import { DeliveryEvent, AttemptEvent, EvidenceEvent } from "@otp-router/engine/delivery";
import { ApplicationGroup } from "./application/api.js";
import { HistoryGroup } from "./history/api.js";
import { AdminGroup } from "./projects/api.js";
import { RuntimeGroup } from "./runtime/api.js";
import { WebhookGroup } from "./callbacks/api.js";

export const OtpRouterApi = HttpApi.make("otpRouter")
  .add(ApplicationGroup, HistoryGroup, AdminGroup, RuntimeGroup, WebhookGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "OTP Router API",
      version: "0.2.0",
      description:
        "Project administration, backend delivery and verification, and provider callback ingress.",
    }),
  );
const makeOpenApiDocument = () => ({
  ...OpenApi.fromApi(OtpRouterApi),
  webhooks: Object.fromEntries(
    Object.entries({
      "challenge.updated": Schema.toJsonSchemaDocument(ChallengeEvent),
      "delivery.updated": Schema.toJsonSchemaDocument(DeliveryEvent),
      "attempt.updated": Schema.toJsonSchemaDocument(AttemptEvent),
      "attempt.evidence": Schema.toJsonSchemaDocument(EvidenceEvent),
    }).map(([kind, eventSchema]) => [
      kind,
      {
        post: {
          summary: "An immutable snapshot delivered at least once; events may arrive out of order",
          security: [],
          parameters: ["webhook-id", "webhook-timestamp", "webhook-signature"].map((name) => ({
            name,
            in: "header",
            required: true,
            schema: { type: "string" },
          })),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { ...eventSchema.schema, $defs: eventSchema.definitions },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Receiver durably recorded the authenticated event (any 2xx acknowledges receipt)",
            },
          },
        },
      },
    ]),
  ),
});

export const openApiDocument = /* @__PURE__ */ makeOpenApiDocument();

export { ErrorBody } from "./responses.js";

export { DeliveryInput } from "@otp-router/engine/challenges";
