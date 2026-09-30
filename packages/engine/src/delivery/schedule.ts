import { captureAuthority } from "../runtime/store.js";
import { requireAccess } from "../projects/store.js";
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
  authority: { readonly time: Date } & (
    | { readonly principalId: string }
    | { readonly intentId: string }
  ),
) =>
  Effect.gen(function* () {
    const { time } = authority;
    const sql = yield* SqlClient.SqlClient;
    const provider = operation.snapshot.providers[position];
    if (provider === undefined)
      return yield* Effect.die(new Error("Invalid persisted route position"));
    const id = randomUUID();
    let intentId: string;
    if ("intentId" in authority) intentId = authority.intentId;
    else {
      const access = yield* requireAccess(operation.project_id, authority.principalId, true);
      intentId = randomUUID();
      if (reason === "fallback")
        return yield* Effect.die(new Error("Fallback requires an existing intent"));
      const authoritySnapshot = yield* captureAuthority(
        operation.project_id,
        operation.policy_id,
        operation.snapshot.providers.map((step) => step.providerInstanceId),
      );
      yield* sql`INSERT INTO otp_router.send_intents(id,operation_id,principal_grant_id,project_send_epoch,action,created_at,authority) VALUES (${intentId},${operation.id},${access.grantId},${access.project.send_epoch},${reason},${time},${JSON.stringify(authoritySnapshot)}::jsonb)`;
    }
    yield* sql`INSERT INTO otp_router.delivery_attempts(id,operation_id,intent_id,route_position,routing_revision,reason,created_at,state,authorization_state) VALUES (${id},${operation.id},${intentId},${position},${operation.routing_revision},${reason},${time},'pending',${operation.snapshot.authorizationRequired ? "pending" : "not_required"})`;
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
