import * as PgClient from "@effect/sql-pg/PgClient";
import { Config } from "effect";

export const DatabaseLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
});
