import { randomUUID } from "node:crypto";
import { SqlClient } from "effect/unstable/sql";
import { Effect } from "effect";
import { enqueueDelivery } from "../queue/jobs.js";
import type { Challenge, Delivery } from "../challenges/records.js";

export const schedule = (
  challenge: Challenge,
  position: number,
  reason: Delivery["reason"],
  time: Date,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const provider = challenge.snapshot.providers[position];
    if (provider === undefined)
      return yield* Effect.die(new Error("Invalid persisted route position"));
    const id = reason === "initial" ? challenge.current_delivery_id : randomUUID();
    yield* sql`INSERT INTO otp_router.deliveries(id,challenge_id,provider_instance_id,route_position,routing_revision,reason,due_at,state) VALUES (${id},${challenge.id},${provider.providerInstanceId},${position},${challenge.routing_revision},${reason},${time},'pending')`;
    yield* sql`INSERT INTO otp_router.provider_correlations(provider_instance_id,reference,delivery_id) VALUES (${provider.providerInstanceId},${id},${id})`;
    yield* sql`UPDATE otp_router.challenges SET current_delivery_id = ${id} WHERE id = ${challenge.id}`;
    yield* enqueueDelivery({
      version: 1,
      deliveryId: id,
      routingRevision: challenge.routing_revision,
    });
    return id;
  });
