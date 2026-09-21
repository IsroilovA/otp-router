import { changed } from "./changes.js";
import { randomUUID } from "node:crypto";
import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";
import { enqueueDelivery } from "../queue/jobs.js";
import type { Operation, Attempt } from "./records.js";

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
    yield* sql`INSERT INTO otp_router.delivery_attempts(id,operation_id,provider_instance_id,route_position,routing_revision,reason,due_at,state) VALUES (${id},${operation.id},${provider.providerInstanceId},${position},${operation.routing_revision},${reason},${time},'pending')`;
    yield* sql`INSERT INTO otp_router.provider_correlations(provider_instance_id,reference,attempt_id) VALUES (${provider.providerInstanceId},${id},${id})`;
    yield* sql`UPDATE otp_router.delivery_operations SET current_attempt_id = ${id} WHERE id = ${operation.id}`;
    yield* enqueueDelivery({
      version: 1,
      attemptId: id,
      routingRevision: operation.routing_revision,
    });
    yield* changed(operation.id);
    return id;
  });
