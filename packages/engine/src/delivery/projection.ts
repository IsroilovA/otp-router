import type { Snapshot } from "./contracts.js";
import { Context, type Effect, type Schema, type Cause } from "effect";
import type { PgClient } from "@effect/sql-pg";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import type { Queue } from "../queue/client.js";
import type { QueueOperationError } from "../queue/jobs.js";
import type { DomainError } from "../errors.js";
// The owning capability projects its state in the same transaction. Delivery never
// knows operation records or verification rules. Composition supplies this boundary.
export class OwnerProjection extends Context.Service<
  OwnerProjection,
  {
    readonly publish: (
      operationId: string,
      time: Date,
      delivery: Snapshot,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | Schema.SchemaError
      | Cause.NoSuchElementError
      | QueueOperationError
      | DomainError,
      PgClient.PgClient | SqlClient.SqlClient | Queue
    >;
  }
>()("otp-router/OwnerProjection") {}
