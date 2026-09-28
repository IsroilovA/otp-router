import { Data, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { CorrelationReference } from "../providers/contract.js";
import { rows } from "../database/query.js";

export class CorrelationConflict extends Data.TaggedError("CorrelationConflict")<{}> {}
export const attemptReference = (id: string) => `attempt:${id}`;
export const providerReference = (id: string) => `provider:${id}`;
export const correlationKey = (reference: CorrelationReference) => {
  switch (reference._tag) {
    case "Attempt":
      return attemptReference(reference.attemptId);
    case "ProviderRequest":
      return providerReference(reference.providerRequestId);
  }
};
export const findCorrelation = (providerId: string, reference: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* rows(
      Schema.Struct({ attempt_id: Schema.String }),
      sql`SELECT attempt_id FROM otp_router.provider_correlations WHERE provider_instance_id = ${providerId} AND reference = ${reference}`,
    ))[0]?.attempt_id;
  });
// The caller holds the provider inbox lock before adding an alias.
export const registerCorrelation = (providerId: string, reference: string, attemptId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO otp_router.provider_correlations(provider_instance_id,reference,attempt_id) VALUES (${providerId},${reference},${attemptId}) ON CONFLICT DO NOTHING`;
    if ((yield* findCorrelation(providerId, reference)) !== attemptId)
      return yield* Effect.fail(new CorrelationConflict());
  });
