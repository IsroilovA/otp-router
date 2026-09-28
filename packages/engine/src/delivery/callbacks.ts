import { deliveryTransaction as transaction } from "./transaction.js";
import { SqlClient } from "effect/unstable/sql";
import { Effect, Schema } from "effect";
import { providerDiagnostic } from "../providers/diagnostics.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { rows } from "../database/query.js";
import { databaseTime } from "../database/transaction.js";
import type { NormalizedDeliveryEvent, SendAccepted } from "../providers/contract.js";
import { expire, findOperation, findAttempt } from "./store.js";
import { mergeLockedOutcome } from "./outcomes.js";
import {
  correlationKey,
  findCorrelation,
  providerReference,
  registerCorrelation,
} from "./correlation.js";

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
const eventReferences = (events: readonly NormalizedDeliveryEvent[]) =>
  events.flatMap((event) => [
    correlationKey(event.correlationReference),
    ...(event.providerRequestId === undefined ? [] : [providerReference(event.providerRequestId)]),
  ]);

const lockInboxOperations = (
  providerId: string,
  references: readonly string[],
  operationId?: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Different instances can reference the same operations. Lock every parent in
    // one order before aliases (which lock attempt FKs), inbox rows, or evidence.
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`callback:${providerId}`},0))`;
    const correlated = yield* rows(
      Schema.Struct({ operation_id: Schema.String }),
      sql`SELECT DISTINCT a.operation_id FROM otp_router.provider_correlations c JOIN otp_router.delivery_attempts a ON a.id = c.attempt_id WHERE c.provider_instance_id = ${providerId} AND ${sql.in("c.reference", references)}`,
    );
    const ids = new Set(correlated.map((row) => row.operation_id));
    if (operationId !== undefined) ids.add(operationId);
    for (const id of [...ids].sort()) yield* findOperation(id, true);
  });

const reconcile = (config: RuntimeConfiguration, providerId: string, reference: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attemptId = yield* findCorrelation(providerId, reference);
    if (attemptId === undefined) return;
    const initial = yield* findAttempt(attemptId);
    const locked = yield* findOperation(initial.operation_id);
    const operation = yield* expire(locked, yield* databaseTime);
    const events = yield* rows(
      Inbox,
      sql`SELECT * FROM otp_router.callback_inbox WHERE provider_instance_id = ${providerId} AND reference = ${reference} AND processed = false ORDER BY received_at,deduplication_key FOR UPDATE`,
    );
    for (const event of events) {
      const delivery = yield* findAttempt(attemptId);
      yield* mergeLockedOutcome(config, yield* findOperation(operation.id), delivery, {
        state: event.status,
        acceptance: "accepted",
        ...(event.diagnostic_code === null ? {} : { diagnosticCode: event.diagnostic_code }),
      });
      yield* sql`UPDATE otp_router.callback_inbox SET processed = true WHERE provider_instance_id = ${providerId} AND deduplication_key = ${event.deduplication_key}`;
    }
  });
const ingestLockedEvents = (
  config: RuntimeConfiguration,
  providerId: string,
  events: readonly NormalizedDeliveryEvent[],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const references = new Set<string>();
    for (const event of events) {
      const reference = correlationKey(event.correlationReference);
      references.add(reference);
      if (event.providerRequestId !== undefined && event.correlationReference._tag === "Attempt") {
        const attemptId = yield* findCorrelation(providerId, reference);
        if (attemptId !== undefined) {
          const alias = providerReference(event.providerRequestId);
          yield* registerCorrelation(providerId, alias, attemptId);
          references.add(alias);
        }
      }
      // A provider cancellation report is final failure evidence, never local cancellation or verification.
      const status = event.status === "cancelled" ? "failed" : event.status;
      yield* sql`INSERT INTO otp_router.callback_inbox(provider_instance_id,deduplication_key,reference,status,received_at,event_at,diagnostic_code) VALUES (${providerId},${event.deduplicationKey},${reference},${status},clock_timestamp(),${event.providerEventTime ?? null},${event.diagnosticCode === undefined ? null : providerDiagnostic(config.providers.get(providerId), event.diagnosticCode)}) ON CONFLICT DO NOTHING`;
    }
    for (const reference of [...references].sort()) yield* reconcile(config, providerId, reference);
  });

export const ingestEvents = (
  config: RuntimeConfiguration,
  providerId: string,
  events: readonly NormalizedDeliveryEvent[],
) =>
  transaction(
    config,
    Effect.gen(function* () {
      yield* lockInboxOperations(providerId, eventReferences(events));
      yield* ingestLockedEvents(config, providerId, events);
    }),
  );
export const recordAccepted = (config: RuntimeConfiguration, id: string, accepted: SendAccepted) =>
  transaction(
    config,
    Effect.gen(function* () {
      const initial = yield* findAttempt(id);
      const events = accepted.deliveryEvent === undefined ? [] : [accepted.deliveryEvent];
      yield* lockInboxOperations(
        initial.provider_instance_id,
        [
          ...eventReferences(events),
          ...(accepted.providerRequestId === undefined
            ? []
            : [providerReference(accepted.providerRequestId)]),
        ],
        initial.operation_id,
      );
      const locked = yield* findOperation(initial.operation_id);
      const operation = yield* expire(locked, yield* databaseTime);
      const delivery = yield* findAttempt(id);
      yield* mergeLockedOutcome(config, operation, delivery, {
        state: "accepted",
        acceptance: "accepted",
        ...(accepted.providerRequestId === undefined
          ? {}
          : { providerRequestId: accepted.providerRequestId }),
      });
      if (accepted.providerRequestId !== undefined) {
        const reference = providerReference(accepted.providerRequestId);
        yield* registerCorrelation(delivery.provider_instance_id, reference, id);
        yield* reconcile(config, delivery.provider_instance_id, reference);
      }
      yield* ingestLockedEvents(config, delivery.provider_instance_id, events);
    }),
  );
