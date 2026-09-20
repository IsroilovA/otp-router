import * as PgClient from "@effect/sql-pg/PgClient";
import { Config } from "effect";

export const DatabaseLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
  maxConnections: Config.succeed(10),
  connectTimeout: Config.succeed("5 seconds"),
  idleTimeout: Config.succeed("30 seconds"),
});
