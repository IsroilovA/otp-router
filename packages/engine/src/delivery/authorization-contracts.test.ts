import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { vi } from "vitest";
import {
  httpSendAuthorizer,
  SendAuthorizer,
  type AuthorizationRequest,
} from "./authorization-contracts.js";

const request: AuthorizationRequest = {
  deploymentId: "test",
  projectId: "alpha",
  attemptId: "00000000-0000-4000-8000-000000000001",
  operationId: "00000000-0000-4000-8000-000000000002",
  providerInstanceId: "sms",
  channel: "sms",
  reason: "initial",
  dispatchDeadline: "2030-01-01T00:00:00.000Z",
};
const approved = {
  deploymentId: request.deploymentId,
  projectId: request.projectId,
  attemptId: request.attemptId,
  decision: "approved",
  reservationId: "reservation-1",
  validUntil: request.dispatchDeadline,
};
const layer = httpSendAuthorizer({
  url: "https://authority.invalid/reservations",
  token: Redacted.make("independent-authority-secret"),
});
const reserve = Effect.flatMap(SendAuthorizer, (authority) => authority.reserve(request)).pipe(
  Effect.provide(layer),
);

it.effect(
  "uses the stable attempt URI and independent authentication for reservation reconciliation",
  () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() => Promise.resolve(Response.json(approved)));
      vi.stubGlobal("fetch", fetch);
      expect(yield* reserve).toEqual(approved);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[0]).toEqual(
        new URL(`https://authority.invalid/reservations/${request.attemptId}`),
      );
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({
        method: "PUT",
        redirect: "error",
        headers: { authorization: "Bearer independent-authority-secret" },
        body: JSON.stringify(request),
      });
    }),
);

it.effect(
  "rejects malformed, oversized, and non-success authority responses without transport retries",
  () =>
    Effect.gen(function* () {
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal("fetch", fetch);
      for (const response of [
        Response.json({ ...approved, secret: "must-not-leak" }),
        new Response("x".repeat(16385)),
        new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid" } }),
        Response.json(approved, { status: 503 }),
      ]) {
        fetch.mockResolvedValueOnce(response);
        const result = yield* reserve.pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "AuthorizationUnavailable" },
        });
        expect(JSON.stringify(result)).not.toContain("must-not-leak");
      }
      expect(fetch).toHaveBeenCalledTimes(4);
    }),
);
