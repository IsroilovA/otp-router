import { DeliveryOwner } from "./owner.js";
import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import { single } from "../database/query.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { persistEvent } from "../history/publication.js";
import { databaseTime } from "../database/transaction.js";
import { type DeliveryEvent, Snapshot } from "./contracts.js";
import { canonical } from "../crypto.js";
import { Changes } from "./changes.js";
import { findOperation } from "./store.js";
import { buildSnapshot } from "./snapshot.js";
import type { Operation } from "./records.js";

const comparable = ({ revision: _revision, serverTime: _time, ...value }: Snapshot) =>
  canonical(value);
export const publish = (config: RuntimeConfiguration, operation: Operation, time: Date) =>
  Effect.gen(function* () {
    const previous = operation.public_snapshot;
    if (previous?.state === "closed" || previous?.state === "expired") return previous;
    const next = yield* buildSnapshot(config, operation, time);
    if (previous !== null && comparable(previous) === comparable(next)) return previous;
    const sql = yield* PgClient.PgClient;
    const event: Omit<DeliveryEvent, "sequence"> = {
      projectId: operation.project_id,
      eventId: randomUUID(),
      type: "delivery.updated",
      occurredAt: time.toISOString(),
      delivery: next,
    };
    yield* sql`UPDATE otp_router.delivery_operations SET public_revision = ${next.revision}, public_snapshot = ${sql.json(next)} WHERE id = ${operation.id}`;
    yield* persistEvent(event);
    return next;
  });
export const flushChanges = (config: RuntimeConfiguration, time?: Date) =>
  Effect.gen(function* () {
    const changes = yield* Changes;
    if (changes === undefined) return;
    for (const id of changes) {
      const publishedAt = time ?? (yield* databaseTime);
      const operation = yield* findOperation(id);
      const owner = operation.owner === "challenge" ? yield* DeliveryOwner : undefined;
      const delivery = yield* publish(config, operation, publishedAt);
      if (owner !== undefined) yield* owner.publish(operation, publishedAt, delivery);
    }
    changes.clear();
  });
// Publish before saving the mutation receipt, including any owning challenge.
export const snapshot = (config: RuntimeConfiguration, operation: Operation, time: Date) =>
  Effect.gen(function* () {
    yield* flushChanges(config, time);
    const sql = yield* PgClient.PgClient;
    const current = yield* single(
      Schema.Struct({ public_snapshot: Schema.NullOr(Snapshot) }),
      sql`SELECT public_snapshot FROM otp_router.delivery_operations WHERE id = ${operation.id}`,
    );
    if (current.public_snapshot === null)
      return yield* Effect.die(new Error("Delivery snapshot missing after publication"));
    return { ...current.public_snapshot, serverTime: time.toISOString() };
  });
