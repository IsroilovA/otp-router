import { OwnerProjection } from "./projection.js";
import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { persistEvent } from "../notifications/publication.js";
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
    yield* persistEvent(event, config.settings.webhook !== undefined);
    return next;
  });
export const flushChanges = (config: RuntimeConfiguration, time?: Date) =>
  Effect.gen(function* () {
    const changes = yield* Changes;
    if (changes === undefined) return;
    for (const id of changes) {
      const publishedAt = time ?? (yield* databaseTime);
      const delivery = yield* publish(config, id, publishedAt);
      if ((yield* findOperation(id)).owner === "challenge")
        yield* (yield* OwnerProjection).publish(id, publishedAt, delivery);
    }
    changes.clear();
  });
// Publish before saving the mutation receipt, including any owning challenge.
export const snapshot = (config: RuntimeConfiguration, operation: Operation, time: Date) =>
  Effect.gen(function* () {
    yield* flushChanges(config, time);
    const current = yield* findOperation(operation.id);
    if (current.public_snapshot === null)
      return yield* Effect.die(new Error("Delivery snapshot missing after publication"));
    return { ...current.public_snapshot, serverTime: time.toISOString() };
  });
