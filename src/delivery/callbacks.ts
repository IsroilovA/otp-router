import { SqlClient } from "effect/unstable/sql";
import { Data, Effect, Schema } from "effect";
import { providerDiagnostic } from "../providers/diagnostics.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { rows } from "../database/query.js";
import { databaseTime, transaction } from "../database/transaction.js";
import type { NormalizedDeliveryEvent, SendAccepted } from "../providers/contract.js";
import { expire, findChallenge, findDelivery } from "../challenges/store.js";
import { mergeLockedOutcome } from "./outcomes.js";

export class CorrelationConflict extends Data.TaggedError("CorrelationConflict")<{}> {}
const Inbox = Schema.Struct({
  provider_instance_id: Schema.String,
  deduplication_key: Schema.String,
  reference: Schema.String,
  status: Schema.Literals(["accepted", "delivered", "failed"]),
  received_at: Schema.Date,
  event_at: Schema.NullOr(Schema.String),
  processed: Schema.Boolean,
  diagnostic_code: Schema.NullOr(Schema.String),
});
const reconcile = (config: RuntimeConfiguration, providerId: string, reference: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const match = (yield* rows(
      Schema.Struct({ delivery_id: Schema.String }),
      sql`SELECT delivery_id FROM otp_router.provider_correlations WHERE provider_instance_id = ${providerId} AND reference = ${reference}`,
    ))[0];
    if (match === undefined) return;
    const initial = yield* findDelivery(match.delivery_id);
    const locked = yield* findChallenge(initial.challenge_id, true);
    const challenge = yield* expire(locked, yield* databaseTime);
    const events = yield* rows(
      Inbox,
      sql`SELECT * FROM otp_router.callback_inbox WHERE provider_instance_id = ${providerId} AND reference = ${reference} AND processed = false ORDER BY received_at,deduplication_key FOR UPDATE`,
    );
    for (const event of events) {
      const delivery = yield* findDelivery(match.delivery_id);
      yield* mergeLockedOutcome(config, challenge, delivery, {
        state: event.status,
        acceptance: "accepted",
        ...(event.diagnostic_code === null ? {} : { diagnosticCode: event.diagnostic_code }),
      });
      yield* sql`UPDATE otp_router.callback_inbox SET processed = true WHERE provider_instance_id = ${providerId} AND deduplication_key = ${event.deduplication_key}`;
    }
  });
export const ingestEvents = (
  config: RuntimeConfiguration,
  providerId: string,
  events: readonly NormalizedDeliveryEvent[],
) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Serialize each instance's inbox and response correlation before challenge locks.
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`callback:${providerId}`},0))`;
      for (const event of events) {
        // A provider cancellation report is final failure evidence, never local cancellation or verification.
        const status = event.status === "cancelled" ? "failed" : event.status;
        yield* sql`INSERT INTO otp_router.callback_inbox(provider_instance_id,deduplication_key,reference,status,received_at,event_at,diagnostic_code) VALUES (${providerId},${event.deduplicationKey},${event.correlationReference},${status},clock_timestamp(),${event.providerEventTime ?? null},${event.diagnosticCode === undefined ? null : providerDiagnostic(config.providers.get(providerId), event.diagnosticCode)}) ON CONFLICT DO NOTHING`;
      }
      for (const reference of [
        ...new Set(events.map((event) => event.correlationReference)),
      ].sort())
        yield* reconcile(config, providerId, reference);
    }),
  );
export const recordAccepted = (config: RuntimeConfiguration, id: string, accepted: SendAccepted) =>
  transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const initial = yield* findDelivery(id);
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`callback:${initial.provider_instance_id}`},0))`;
      const locked = yield* findChallenge(initial.challenge_id, true);
      const challenge = yield* expire(locked, yield* databaseTime);
      const delivery = yield* findDelivery(id);
      yield* mergeLockedOutcome(config, challenge, delivery, {
        state: "accepted",
        acceptance: "accepted",
        ...(accepted.providerRequestId === undefined
          ? {}
          : { providerRequestId: accepted.providerRequestId }),
      });
      if (accepted.providerRequestId !== undefined) {
        yield* sql`INSERT INTO otp_router.provider_correlations(provider_instance_id,reference,delivery_id) VALUES (${delivery.provider_instance_id},${accepted.providerRequestId},${id}) ON CONFLICT DO NOTHING`;
        const owner = (yield* rows(
          Schema.Struct({ delivery_id: Schema.String }),
          sql`SELECT delivery_id FROM otp_router.provider_correlations WHERE provider_instance_id = ${delivery.provider_instance_id} AND reference = ${accepted.providerRequestId}`,
        ))[0];
        if (owner?.delivery_id !== id) return yield* Effect.fail(new CorrelationConflict());
        yield* reconcile(config, delivery.provider_instance_id, accepted.providerRequestId);
      }
      if (accepted.deliveryEvent !== undefined)
        yield* ingestEvents(config, delivery.provider_instance_id, [accepted.deliveryEvent]);
    }),
  );
