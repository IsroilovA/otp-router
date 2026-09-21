import { OwnerProjection } from "./projection.js";
import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { scheduleNotification } from "../notifications/schedule.js";
import { databaseTime } from "../database/transaction.js";
import type { DeliveryEvent, Snapshot } from "./contracts.js";
import { canonical } from "../crypto.js";
import { Changes } from "./changes.js";
import { findOperation } from "./store.js";
import { buildSnapshot } from "./snapshot.js";
import type { Operation } from "./records.js";

const comparable = ({ revision: _revision, serverTime: _time, ...value }: Snapshot) =>
  canonical(value);
export const publish = (config: RuntimeConfiguration, id: string, time: Date) =>
  Effect.gen(function* () {
    const operation = yield* findOperation(id);
    const next = yield* buildSnapshot(config, operation, time);
    const previous = operation.public_snapshot;
    if (previous !== null && comparable(previous) === comparable(next)) return previous;
    const sql = yield* PgClient.PgClient;
    const event: DeliveryEvent = {
      eventId: randomUUID(),
      type: "delivery.updated",
      occurredAt: time.toISOString(),
      delivery: next,
    };
    yield* sql`UPDATE otp_router.delivery_operations SET public_revision = ${next.revision}, public_snapshot = ${sql.json(next)} WHERE id = ${id}`;
    yield* sql`INSERT INTO otp_router.events(id,subject_id,kind,revision,occurred_at,body) VALUES (${event.eventId},${id},'delivery.updated',${next.revision},${time},${JSON.stringify(event)})`;
    if (config.settings.webhook !== undefined) {
      yield* scheduleNotification(event.eventId, time);
    }
    return next;
  });
export const flushChanges = (config: RuntimeConfiguration) =>
  Effect.gen(function* () {
    const changes = yield* Changes;
    if (changes === undefined) return;
    for (const id of changes) {
      const time = yield* databaseTime;
      yield* publish(config, id, time);
      if ((yield* findOperation(id)).owner === "challenge")
        yield* (yield* OwnerProjection).publish(id, time);
    }
    changes.clear();
  });
// Mutation responses are generated after their final domain change and before the
// idempotency result is stored. Reads only replace serverTime.
export const snapshot = (config: RuntimeConfiguration, operation: Operation, time: Date) =>
  Effect.gen(function* () {
    const changes = yield* Changes;
    const value =
      changes?.has(operation.id) === true || operation.public_snapshot === null
        ? yield* publish(config, operation.id, time)
        : operation.public_snapshot;
    if (operation.owner === "external") changes?.delete(operation.id);
    return { ...value, serverTime: time.toISOString() };
  });
