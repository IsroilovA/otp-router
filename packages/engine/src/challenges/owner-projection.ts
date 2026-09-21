import { SqlClient } from "effect/unstable/sql";
import { Effect, Layer, Schema } from "effect";
import { RouterConfig } from "../config/runtime.js";
import { rows } from "../database/query.js";
import { OwnerProjection } from "../delivery/projection.js";
import { findChallenge, eraseSecrets } from "./store.js";
import { publish } from "./publication.js";
export const OwnerProjectionLive = Layer.effect(
  OwnerProjection,
  Effect.gen(function* () {
    const config = yield* RouterConfig;
    return {
      publish: (operationId, time, delivery) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const row = (yield* rows(
            Schema.Struct({ id: Schema.String }),
            sql`SELECT id FROM otp_router.challenges WHERE operation_id = ${operationId} FOR UPDATE`,
          ))[0];
          if (row === undefined)
            return yield* Effect.die(new Error("Managed delivery owner missing"));
          const challenge = yield* findChallenge(row.id);
          if (
            challenge.verification_state === "active" &&
            (challenge.delivery.state === "closed" || challenge.delivery.state === "expired")
          ) {
            yield* sql`UPDATE otp_router.challenges SET verification_state = ${challenge.delivery.state === "expired" ? "expired" : "cancelled"}, terminal_at = ${time} WHERE id = ${row.id} AND verification_state = 'active'`;
            yield* eraseSecrets(row.id);
          }
          yield* publish(config, row.id, delivery, time);
        }),
    };
  }),
);
