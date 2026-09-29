import { transitionAttempts } from "./attempts.js";
import { changed } from "./changes.js";
import { randomUUID } from "node:crypto";
import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";
import { enqueueDelivery } from "../queue/jobs.js";
import type { Operation, Attempt } from "./records.js";
import { attemptReference } from "./correlation.js";

export const schedule = (
  operation: Operation,
  position: number,
  reason: Attempt["reason"],
  time: Date,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const provider = operation.snapshot.providers[position];
    if (provider === undefined)
      return yield* Effect.die(new Error("Invalid persisted route position"));
    const id = randomUUID();
    yield* sql`INSERT INTO otp_router.delivery_attempts(id,operation_id,route_position,routing_revision,reason,created_at,state,authorization_state) VALUES (${id},${operation.id},${position},${operation.routing_revision},${reason},${time},'pending',${operation.snapshot.authorizationRequired ? "pending" : "not_required"})`;
    yield* transitionAttempts(sql`SELECT id FROM otp_router.delivery_attempts WHERE id = ${id}`);
    yield* sql`INSERT INTO otp_router.provider_correlations(provider_instance_id,reference,attempt_id) VALUES (${provider.providerInstanceId},${attemptReference(id)},${id})`;
    yield* sql`UPDATE otp_router.delivery_operations SET current_attempt_id = ${id} WHERE id = ${operation.id}`;
    yield* enqueueDelivery({
      version: 1,
      attemptId: id,
      routingRevision: operation.routing_revision,
    });
    yield* changed(operation.id);
    return id;
  });
