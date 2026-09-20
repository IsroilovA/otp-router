import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, type Redacted } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";

export const makeDatabaseLayer = (url: Redacted.Redacted<string>) =>
  PgClient.layerFrom(
    Effect.gen(function* () {
      const pg = yield* PgClient.make({
        url,
        maxConnections: 10,
        connectTimeout: "5 seconds",
        idleTimeout: "30 seconds",
      });
      // The native pool's connect timeout does not bound waiting for a free connection.
      // Bound acquisition only; never time out a transaction's commit through this deadline.
      const acquirer = pg.reserve.pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () =>
            Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.ConnectionError({
                  cause: undefined,
                  message: "Database pool acquisition timed out",
                }),
              }),
            ),
        }),
      );
      const sql = yield* SqlClient.make({
        acquirer,
        compiler: PgClient.makeCompiler(),
        prepareTransactionControls: true,
        spanAttributes: [["db.system.name", "postgresql"]],
      });
      return Object.assign(sql, {
        [PgClient.TypeId]: PgClient.TypeId,
        config: pg.config,
        json: pg.json,
        listen: pg.listen,
        notify: pg.notify,
      });
    }),
  );
