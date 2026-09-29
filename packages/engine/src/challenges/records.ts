import { Schema } from "effect";
import { Snapshot } from "./contracts.js";
import { Digest } from "../crypto.js";
import { Operation } from "../delivery/records.js";
export const Challenge = Schema.Struct({
  id: Schema.String,
  operation_id: Schema.String,
  code_length: Schema.Int,
  max_incorrect_guesses: Schema.Int,
  verification_state: Schema.Literals(["active", "verified", "locked", "expired", "cancelled"]),
  verification_id: Schema.NullOr(Schema.String),
  incorrect_guesses: Schema.Int,
  public_revision: Schema.Int,
  public_snapshot: Schema.NullOr(Snapshot),
  delivery: Operation,
});
export type Challenge = typeof Challenge.Type;
export const Secrets = Schema.Struct({ challenge_id: Schema.String, verifier: Digest });
