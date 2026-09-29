import { SqlClient } from "effect/unstable/sql";
import { Effect, Layer } from "effect";
import { RouterConfig } from "../config/runtime.js";
import { DeliveryOwner } from "../delivery/owner.js";
import { findOwnedChallenge, eraseSecrets } from "./store.js";
import { publish } from "./publication.js";
export const DeliveryOwnerLive = Layer.effect(
  DeliveryOwner,
  Effect.gen(function* () {
    const config = yield* RouterConfig;
    return {
      synchronize: (operation) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const challenge = yield* findOwnedChallenge(operation, true);
          if (operation.state !== "closed" && operation.state !== "expired") return;
          yield* sql`UPDATE otp_router.challenges SET verification_state = ${operation.state === "expired" ? "expired" : "cancelled"} WHERE id = ${challenge.id} AND verification_state = 'active'`;
          yield* eraseSecrets(challenge.id);
        }),
      publish: (operation, time, delivery) =>
        Effect.gen(function* () {
          const challenge = yield* findOwnedChallenge(operation);
          yield* publish(config, challenge, delivery, time);
        }),
    };
  }),
);
