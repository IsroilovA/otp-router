import { randomUUID } from "node:crypto";
import { NodeServices } from "@effect/platform-node";
import { Data, Deferred, Effect, Exit, Fiber, Layer, Redacted, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Configuration } from "../packages/engine/src/config/config.js";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgClient } from "@effect/sql-pg";
import { makeDatabaseLayer } from "../packages/engine/src/database/client.js";
import { migrate } from "../packages/engine/src/database/migrations.js";
import { rows, single } from "../packages/engine/src/database/query.js";
import { transaction } from "../packages/engine/src/database/transaction.js";
import { FakeProvider, ProviderInstanceIdSchema } from "../packages/engine/src/providers/index.js";
import { enqueueDelivery, deliveryQueue } from "../packages/engine/src/queue/jobs.js";
import {
  startPostgres,
  startRuntime,
  type IntegrationRuntime,
  type PostgresFixture,
} from "./fixture.js";
const keyRing = (n: number) => ({
  active: "a",
  keys: { a: Buffer.alloc(32, n).toString("base64url") },
});
const configuration: Configuration = {
  settings: {
    crypto: {
      deploymentId: "queue-tests",
      encryption: keyRing(1),
      verification: keyRing(2),
      fingerprint: keyRing(3),
      recipientKey: Buffer.alloc(32, 4).toString("base64url"),
    },
    defaultLocale: "en",
    fallbackLocales: [],
    policies: { login: { providerInstanceIds: ["fake"] } },
    purposes: { login: ["login"] },
    deploymentSendLimit15m: 100,
    deploymentSendLimit24h: 1000,
  },
  providers: [
    FakeProvider.make({
      instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)("fake"),
      enabled: true,
      settingsFingerprint: "fake",
      config: { outcome: "accepted", callbackSecret: Redacted.make("secret") },
      templates: {},
    }),
  ],
};
class Rollback extends Data.TaggedError("Rollback")<{}> {}
const marker = Schema.Struct({ id: Schema.String });
describe("transaction-local queue integration", () => {
  let database: PostgresFixture | undefined;
  let harness: IntegrationRuntime | undefined;
  const current = () => {
    if (harness === undefined) throw new Error("Missing runtime");
    return harness;
  };
  beforeAll(async () => {
    database = await startPostgres();
    harness = await startRuntime(database.databaseUrl, configuration);
    await harness.run(harness.pg`CREATE TABLE otp_router.integration_markers(id uuid PRIMARY KEY)`);
  }, 30000);
  afterAll(async () => {
    await harness?.close();
    await database?.close();
  }, 15000);
  beforeEach(async () => {
    const h = current();
    await h.reset();
    await h.run(h.pg`DELETE FROM otp_router.integration_markers WHERE id IS NOT NULL`);
  });
  const write = (id: string) =>
    Effect.gen(function* () {
      const h = current();
      yield* h.pg`INSERT INTO otp_router.integration_markers(id) VALUES (${id})`;
      yield* enqueueDelivery({ version: 1, deliveryId: id, routingRevision: 1 });
    });
  const state = async () => {
    const h = current();
    return {
      rows: await h.run(
        rows(marker, h.pg`SELECT id FROM otp_router.integration_markers ORDER BY id`),
      ),
      jobs: (
        await h.run(
          single(
            Schema.Struct({ count: Schema.Number }),
            h.pg`SELECT count(*)::float8 AS count FROM pgboss.job WHERE name = ${deliveryQueue}`,
          ),
        )
      ).count,
    };
  };
  it("commits application and queue writes together, invisible before commit", async () => {
    const h = current();
    const entered = await Effect.runPromise(Deferred.make<void>()),
      release = await Effect.runPromise(Deferred.make<void>());
    const writing = h.run(
      transaction(
        write(randomUUID()).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Deferred.await(release)),
        ),
      ),
    );
    await Effect.runPromise(Deferred.await(entered));
    expect(await state()).toEqual({ rows: [], jobs: 0 });
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await writing;
    expect((await state()).rows).toHaveLength(1);
    expect((await state()).jobs).toBe(1);
  });
  it("rolls both writes back for typed failures and SQL constraint errors", async () => {
    const h = current(),
      id = randomUUID();
    expect(
      (
        await h.run(
          transaction(write(id).pipe(Effect.andThen(Effect.fail(new Rollback())))).pipe(
            Effect.result,
          ),
        )
      )._tag,
    ).toBe("Failure");
    expect(await state()).toEqual({ rows: [], jobs: 0 });
    expect(
      (
        await h.run(
          transaction(
            write(id).pipe(
              Effect.andThen(h.pg`INSERT INTO otp_router.integration_markers(id) VALUES (${id})`),
            ),
          ).pipe(Effect.result),
        )
      )._tag,
    ).toBe("Failure");
    expect(await state()).toEqual({ rows: [], jobs: 0 });
  });
  it("keeps independent concurrent commits and savepoints isolated", async () => {
    const h = current();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        h.run(
          transaction(
            write(randomUUID()).pipe(
              Effect.andThen(index % 2 === 0 ? Effect.void : Effect.fail(new Rollback())),
            ),
          ).pipe(Effect.result),
        ),
      ),
    );
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(6);
    expect((await state()).rows).toHaveLength(6);
    expect((await state()).jobs).toBe(6);
    await h.reset();
    await h.run(h.pg`DELETE FROM otp_router.integration_markers WHERE id IS NOT NULL`);
    await h.run(
      transaction(
        Effect.gen(function* () {
          yield* write(randomUUID());
          yield* transaction(
            write(randomUUID()).pipe(Effect.andThen(Effect.fail(new Rollback()))),
          ).pipe(Effect.result);
        }),
      ),
    );
    expect((await state()).rows).toHaveLength(1);
    expect((await state()).jobs).toBe(1);
  });
  it("rolls an interrupted transaction back after enqueue", async () => {
    const h = current();
    const entered = await Effect.runPromise(Deferred.make<void>());
    await h.run(
      Effect.gen(function* () {
        const fiber = yield* transaction(
          write(randomUUID()).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Effect.never),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(await state()).toEqual({ rows: [], jobs: 0 });
  });
  it("does not abandon the transaction connection when interrupted inside the Promise adapter", async () => {
    const h = current();
    const locked = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const blocker = h.run(
      transaction(
        Effect.gen(function* () {
          yield* h.pg`LOCK TABLE pgboss.job IN ACCESS EXCLUSIVE MODE`;
          yield* Deferred.succeed(locked, undefined);
          yield* Deferred.await(release);
        }),
      ),
    );
    await Effect.runPromise(Deferred.await(locked));
    await h.run(
      Effect.gen(function* () {
        const fiber = yield* transaction(write(randomUUID())).pipe(Effect.forkChild);
        const waiting = single(
          Schema.Struct({ count: Schema.Number }),
          h.pg`SELECT count(*)::float8 AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%insert%pgboss%' AND pid <> pg_backend_pid()`,
        );
        yield* waiting.pipe(
          Effect.repeat({ until: (result) => result.count > 0 }),
          Effect.timeout("3 seconds"),
        );
        const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupted);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
    );
    await blocker;
    expect(await state()).toEqual({ rows: [], jobs: 0 });
    expect(
      (
        await h.run(
          single(
            Schema.Struct({ count: Schema.Number }),
            h.pg`SELECT count(*)::float8 AS count FROM pg_stat_activity WHERE state = 'idle in transaction' AND datname = current_database()`,
          ),
        )
      ).count,
    ).toBe(0);
  });
  it("retains delayed work across runtime restart and respects its persisted due time", async () => {
    const h = current();
    if (database === undefined) throw new Error("Missing database");
    const id = await h.queue.send(
      deliveryQueue,
      { version: 1, deliveryId: randomUUID(), routingRevision: 1 },
      { startAfter: 600 },
    );
    expect(id).not.toBeNull();
    await h.close();
    harness = await startRuntime(database.databaseUrl, configuration);
    expect(await harness.queue.fetch(deliveryQueue)).toEqual([]);
    await harness.run(
      harness.pg`UPDATE pgboss.job SET start_after = clock_timestamp() - interval '1 second' WHERE id = ${id}`,
    );
    const claimed = await harness.queue.fetch(deliveryQueue);
    expect(claimed.map((job) => job.id)).toEqual([id]);
  });

  describe("empty database", () => {
    let freshDatabase: PostgresFixture | undefined;
    beforeAll(async () => {
      freshDatabase = await startPostgres();
    }, 30_000);
    afterAll(async () => {
      await freshDatabase?.close();
    }, 15_000);
    it("rolls back a failed empty-database migration and coordinates fresh process starts", async () => {
      const fresh = freshDatabase;
      if (fresh === undefined) throw new Error("Missing fresh database");
      const runtimes: IntegrationRuntime[] = [];
      const database = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient | SqlClient>) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provide(
              makeDatabaseLayer(Redacted.make(fresh.databaseUrl)).pipe(
                Layer.provideMerge(NodeServices.layer),
              ),
            ),
          ),
        );
      try {
        await database(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient;
            yield* sql`CREATE SCHEMA otp_router`;
            const failure = yield* migrate.pipe(Effect.provide(NodeServices.layer), Effect.exit);
            expect(Exit.isFailure(failure)).toBe(true);
            const history = yield* single(
              Schema.Struct({ name: Schema.NullOr(Schema.String) }),
              sql`SELECT to_regclass('public.effect_sql_migrations')::text AS name`,
            );
            expect(history.name).toBeNull();
            yield* sql`DROP SCHEMA otp_router`;
          }),
        );
        const starts = await Promise.allSettled(
          [1, 2].map(async () => {
            const runtime = await startRuntime(fresh.databaseUrl, configuration);
            runtimes.push(runtime);
            return runtime;
          }),
        );
        expect(starts.every((result) => result.status === "fulfilled")).toBe(true);
        const first = runtimes[0];
        if (first === undefined) throw new Error("No runtime started");
        expect(
          (
            await first.run(
              rows(
                Schema.Struct({ migration_id: Schema.Int }),
                first.pg`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`,
              ),
            )
          ).map((row) => row.migration_id),
        ).toEqual([1]);
      } finally {
        await Promise.all(runtimes.map((runtime) => runtime.close()));
      }
    });
  });

  it("keeps migration history in public when the application schema leads the search path", async () => {
    const h = current();
    await h.run(
      h.pg.withTransaction(
        Effect.gen(function* () {
          yield* h.pg`SET LOCAL search_path TO otp_router, public`;
          yield* migrate.pipe(Effect.provide(NodeServices.layer));
          const history = yield* single(
            Schema.Struct({ shadow: Schema.NullOr(Schema.String), count: Schema.Number }),
            h.pg`SELECT to_regclass('otp_router.effect_sql_migrations')::text AS shadow,
              (SELECT count(*)::integer FROM public.effect_sql_migrations) AS count`,
          );
          expect(history).toEqual({ shadow: null, count: 1 });
        }),
      ),
    );
  });

  it("coordinates concurrent migration starts and rejects a future schema", async () => {
    const h = current();
    await Promise.all([
      h.run(migrate.pipe(Effect.provide(NodeServices.layer))),
      h.run(migrate.pipe(Effect.provide(NodeServices.layer))),
    ]);
    expect(
      (
        await h.run(
          single(
            Schema.Struct({ count: Schema.Number }),
            h.pg`SELECT count(*)::float8 AS count FROM effect_sql_migrations`,
          ),
        )
      ).count,
    ).toBe(1);
    await h.run(
      h.pg`INSERT INTO effect_sql_migrations(migration_id,name) VALUES (999,'future_test_fixture')`,
    );
    try {
      expect(
        Exit.isFailure(await h.run(migrate.pipe(Effect.provide(NodeServices.layer), Effect.exit))),
      ).toBe(true);
    } finally {
      await h.run(h.pg`DELETE FROM effect_sql_migrations WHERE migration_id = 999`);
    }
  });
});
