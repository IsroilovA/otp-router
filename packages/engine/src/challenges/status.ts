import { Effect } from "effect";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import type { OperationResult } from "./contracts.js";
import { domainTransaction } from "./transaction.js";
import { expire, findChallenge } from "./store.js";
import { snapshot } from "./publication.js";

export const challengeStatus = (config: RuntimeConfiguration, id: string) =>
  domainTransaction(
    config,
    Effect.gen(function* () {
      const locked = yield* findChallenge(id, true);
      const time = yield* databaseTime;
      const challenge = yield* expire(locked, time);
      return {
        outcome: "completed",
        replayed: false,
        body: yield* snapshot(config, challenge, time),
      } satisfies OperationResult;
    }),
  );
