import type { Snapshot } from "./contracts.js";
import { Context, type Effect, type Schema, type Cause } from "effect";
import type { PgClient } from "@effect/sql-pg";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import type { Queue } from "../queue/client.js";
import type { QueueOperationError } from "../queue/contracts.js";
import type { DomainError } from "../errors.js";
type OwnerEffect<A> = Effect.Effect<
  A,
  | SqlError.SqlError
  | Schema.SchemaError
  | Cause.NoSuchElementError
  | QueueOperationError
  | DomainError,
  PgClient.PgClient | SqlClient.SqlClient | Queue
>;
// Composition supplies managed lifecycle synchronization without letting delivery
// depend on verification. Both operations run inside the delivery transaction.
export class DeliveryOwner extends Context.Service<
  DeliveryOwner,
  {
    readonly synchronize: (operationId: string, time: Date) => OwnerEffect<string>;
    readonly publish: (ownerId: string, time: Date, delivery: Snapshot) => OwnerEffect<void>;
  }
>()("otp-router/DeliveryOwner") {}
