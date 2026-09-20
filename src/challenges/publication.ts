import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { enqueueNotification } from "../queue/jobs.js";
import { databaseTime } from "../database/transaction.js";
import type { ChallengeEvent, Snapshot } from "./contracts.js";
import { canonical } from "./crypto.js";
import { Changes } from "./changes.js";
import { findChallenge } from "./store.js";
import { buildSnapshot } from "./snapshot.js";
import type { Challenge } from "./records.js";

const comparable = ({ revision: _revision, serverTime: _time, ...value }: Snapshot) =>
  canonical(value);
export const publish = (config: RuntimeConfiguration, id: string, time: Date) =>
  Effect.gen(function* () {
    const challenge = yield* findChallenge(id);
    const next = yield* buildSnapshot(config, challenge, time);
    const previous = challenge.public_snapshot;
    if (previous !== null && comparable(previous) === comparable(next)) return previous;
    const sql = yield* PgClient.PgClient;
    const event: ChallengeEvent = {
      eventId: randomUUID(),
      type: "challenge.updated",
      occurredAt: time.toISOString(),
      challenge: next,
    };
    yield* sql`UPDATE otp_router.challenges SET public_revision = ${next.revision}, public_snapshot = ${sql.json(next)} WHERE id = ${id}`;
    yield* sql`INSERT INTO otp_router.challenge_events(id,challenge_id,revision,occurred_at,body) VALUES (${event.eventId},${id},${next.revision},${time},${JSON.stringify(event)})`;
    if (config.settings.webhook !== undefined) {
      yield* sql`INSERT INTO otp_router.notifications(event_id,next_attempt_at) VALUES (${event.eventId},${time})`;
      yield* enqueueNotification(event.eventId, time);
    }
    return next;
  });
export const flushChanges = (config: RuntimeConfiguration) =>
  Effect.gen(function* () {
    const changes = yield* Changes;
    if (changes === undefined) return;
    for (const id of changes) yield* publish(config, id, yield* databaseTime);
    changes.clear();
  });
// Mutation responses are generated after their final domain change and before the
// idempotency result is stored. Reads only replace serverTime.
export const snapshot = (config: RuntimeConfiguration, challenge: Challenge, time: Date) =>
  Effect.gen(function* () {
    const changes = yield* Changes;
    const value =
      changes?.has(challenge.id) === true || challenge.public_snapshot === null
        ? yield* publish(config, challenge.id, time)
        : challenge.public_snapshot;
    changes?.delete(challenge.id);
    return { ...value, serverTime: time.toISOString() };
  });
