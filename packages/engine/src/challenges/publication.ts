import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { persistEvent } from "../notifications/publication.js";
import type { ChallengeEvent, Snapshot } from "./contracts.js";
import { canonical } from "../crypto.js";
import { flushChanges } from "../delivery/publication.js";
import type { Snapshot as DeliverySnapshot } from "../delivery/contracts.js";
import { findChallenge } from "./store.js";
import { buildSnapshot } from "./snapshot.js";
import type { Challenge } from "./records.js";

const comparable = ({ revision: _revision, serverTime: _time, ...value }: Snapshot) =>
  canonical(value);
export const publish = (
  config: RuntimeConfiguration,
  id: string,
  delivery: DeliverySnapshot,
  time: Date,
) =>
  Effect.gen(function* () {
    const challenge = yield* findChallenge(id);
    const next = yield* buildSnapshot(config, challenge, delivery, time);
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
    yield* persistEvent(event, config.settings.webhook !== undefined);
    return next;
  });
export const snapshot = (config: RuntimeConfiguration, challenge: Challenge, time: Date) =>
  Effect.gen(function* () {
    yield* flushChanges(config, time);
    const current = yield* findChallenge(challenge.id);
    if (current.public_snapshot === null)
      return yield* Effect.die(new Error("Challenge snapshot missing after publication"));
    return { ...current.public_snapshot, serverTime: time.toISOString() };
  });
