import { SqlSchema } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Effect } from "effect";
import { Schema } from "effect";

// All returned application rows pass a runtime schema, including JSONB snapshots.
export const rows = <A, I>(
  schema: Schema.Codec<A, I>,
  query: Effect.Effect<ReadonlyArray<unknown>, SqlError>,
) => SqlSchema.findAll({ Request: Schema.Void, Result: schema, execute: () => query })(undefined);
export const single = <A, I>(
  schema: Schema.Codec<A, I>,
  query: Effect.Effect<ReadonlyArray<unknown>, SqlError>,
) => SqlSchema.findOne({ Request: Schema.Void, Result: schema, execute: () => query })(undefined);
