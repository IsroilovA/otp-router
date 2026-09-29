import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect, Schema } from "effect";
import { single } from "../database/query.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { persistEvent } from "../notifications/publication.js";
import { type ChallengeEvent, Snapshot } from "./contracts.js";
import { canonical } from "../crypto.js";
import { flushChanges } from "../delivery/publication.js";
import type { Snapshot as DeliverySnapshot } from "../delivery/contracts.js";
import { buildSnapshot } from "./snapshot.js";
import type { Challenge } from "./records.js";

const comparable = ({ revision: _revision, serverTime: _time, ...value }: Snapshot) =>
  canonical(value);
export const publish = (
  config: RuntimeConfiguration,
  challenge: Challenge,
  delivery: DeliverySnapshot,
  time: Date,
) =>
  Effect.gen(function* () {
    const next = yield* buildSnapshot(config, challenge, delivery, time);
    const previous = challenge.public_snapshot;
    if (previous !== null && comparable(previous) === comparable(next)) return previous;
    const sql = yield* PgClient.PgClient;
    const event: Omit<ChallengeEvent, "sequence"> = {
      projectId: challenge.delivery.project_id,
      eventId: randomUUID(),
      type: "challenge.updated",
      occurredAt: time.toISOString(),
      challenge: next,
    };
    yield* sql`UPDATE otp_router.challenges SET public_revision = ${next.revision}, public_snapshot = ${sql.json(next)} WHERE id = ${challenge.id}`;
    yield* persistEvent(event);
    return next;
  });
export const snapshot = (config: RuntimeConfiguration, challenge: Challenge, time: Date) =>
  Effect.gen(function* () {
    yield* flushChanges(config, time);
    const sql = yield* PgClient.PgClient;
    const current = yield* single(
      Schema.Struct({ public_snapshot: Schema.NullOr(Snapshot) }),
      sql`SELECT public_snapshot FROM otp_router.challenges WHERE id = ${challenge.id}`,
    );
    if (current.public_snapshot === null)
      return yield* Effect.die(new Error("Challenge snapshot missing after publication"));
    return { ...current.public_snapshot, serverTime: time.toISOString() };
  });
