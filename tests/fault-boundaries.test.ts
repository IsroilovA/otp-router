import { randomUUID } from "node:crypto";
import { Effect, Exit, Layer, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OperationResult } from "../packages/engine/src/challenges/contracts.js";
import type { Configuration } from "../packages/engine/src/config/config.js";
import { rows, single } from "../packages/engine/src/database/query.js";
import { transaction } from "../packages/engine/src/database/transaction.js";
import { dispatch } from "../packages/engine/src/delivery/dispatch.js";
import {
  ProviderContractVersion,
  ProviderInstance,
  ProviderInstanceIdSchema,
  type ProviderSendInput,
  type ReadyProvider,
} from "../packages/engine/src/providers/contract.js";
import { deliveryQueue } from "../packages/engine/src/queue/jobs.js";
import {
  type IntegrationRuntime,
  type PostgresFixture,
  startPostgres,
  startRuntime,
} from "./fixture.js";

const key = (byte: number): string => Buffer.alloc(32, byte).toString("base64url");
const sends: ProviderSendInput[] = [];
const providerId = Schema.decodeUnknownSync(ProviderInstanceIdSchema)("fault-test-provider");
const provider: ReadyProvider = {
  instanceId: providerId,
  pluginId: "fault-test-provider",
  version: "1.0.0",
  contractVersion: ProviderContractVersion,
  channel: "fake",
  enabled: true,
  settingsFingerprint: "fault-test-provider-v1",
  constraints: { minCodeLength: 6, maxCodeLength: 8, minDeliveryWindowMs: 0 },
  sendTimeoutMs: 1_000,
  defaultSendTimeoutMs: 1_000,
  diagnosticCodes: [],
  idempotency: { supported: false },
  resolveTemplate: (locales) => {
    const locale = locales[0];
    return locale === undefined
      ? Effect.die(new Error("The fault test configuration has no locale"))
      : Effect.succeed({ locale, template: null });
  },
  send: (input) =>
    Effect.sync(() => {
      sends.push(input);
      return {
        providerRequestId: `fault-test:${input.deliveryId}`,
      };
    }),
};

const configuration: Configuration = {
  settings: {
    crypto: {
      deploymentId: "fault-boundary-tests",
      encryption: { active: "a", keys: { a: key(1) } },
      verification: { active: "a", keys: { a: key(2) } },
      fingerprint: { active: "a", keys: { a: key(3) } },
      recipientKey: key(4),
    },
    defaultLocale: "en",
    fallbackLocales: [],
    policies: { login: { providerInstanceIds: [providerId] } },
    purposes: { login: ["login"] },
    deploymentSendLimit15m: 100,
    deploymentSendLimit24h: 1_000,
  },
  providers: [Layer.succeed(ProviderInstance, provider)],
};

const createInput = {
  recipient: { type: "phone" as const, phoneNumber: "+998901234567" },
  purpose: "login",
  contextId: "fault-boundary-session",
  policyId: "login",
};

const challengeIdFrom = (result: OperationResult): string => {
  if (!("challengeId" in result.body)) throw new Error("Expected a challenge result");
  return result.body.challengeId;
};

const stage = async <A>(name: string, promise: Promise<A>): Promise<A> => {
  try {
    return await promise;
  } catch (error) {
    throw new Error(name, { cause: error });
  }
};

const State = Schema.Struct({
  challenges: Schema.Int,
  secrets: Schema.Int,
  deliveries: Schema.Int,
  pending: Schema.Int,
  reserved: Schema.Int,
  operations: Schema.Int,
  createQuotas: Schema.Int,
  sendQuotas: Schema.Int,
  jobs: Schema.Int,
  sendCount: Schema.Int,
});

describe("PostgreSQL fault boundaries", () => {
  let postgres: PostgresFixture | undefined;
  let application: IntegrationRuntime | undefined;
  let control: IntegrationRuntime | undefined;

  const app = (): IntegrationRuntime => {
    if (application === undefined) throw new Error("Application runtime is not initialized");
    return application;
  };

  const observer = (): IntegrationRuntime => {
    if (control === undefined) throw new Error("Control runtime is not initialized");
    return control;
  };

  const deliveryIdFrom = async (result: OperationResult): Promise<string> => {
    const id = challengeIdFrom(result);
    const harness = observer();
    return (
      await harness.run(
        single(
          Schema.Struct({ id: Schema.String }),
          harness.pg`SELECT id FROM otp_router.deliveries WHERE challenge_id = ${id} AND reason = 'initial'`,
        ),
      )
    ).id;
  };

  const create = (operationKey: string) =>
    Effect.runPromise(
      app().router.create({
        key: operationKey,
        input: createInput,
        requestId: randomUUID(),
      }),
    );

  const state = () => {
    const database = observer();
    return database.run(
      single(
        State,
        database.pg`
          SELECT
            (SELECT count(*) FROM otp_router.challenges)::integer AS challenges,
            (SELECT count(*) FROM otp_router.challenge_secrets)::integer AS secrets,
            (SELECT count(*) FROM otp_router.deliveries)::integer AS deliveries,
            (SELECT count(*) FROM otp_router.deliveries WHERE state = 'pending')::integer AS pending,
            (SELECT count(*) FROM otp_router.deliveries WHERE reserved_at IS NOT NULL)::integer AS reserved,
            (SELECT count(*) FROM otp_router.idempotency_records)::integer AS operations,
            (SELECT count(*) FROM otp_router.quota_events WHERE kind = 'create')::integer AS "createQuotas",
            (SELECT count(*) FROM otp_router.quota_events WHERE kind = 'send')::integer AS "sendQuotas",
            (SELECT count(*) FROM pgboss.job WHERE name = ${deliveryQueue})::integer AS jobs,
            COALESCE((SELECT sum(send_count) FROM otp_router.challenges), 0)::integer AS "sendCount"
        `,
      ),
    );
  };

  const holdApplicationPool = async (): Promise<{
    readonly release: () => void;
    readonly completed: Promise<void>;
  }> => {
    const database = app();
    const release = Promise.withResolvers<void>();
    const entered = Array.from({ length: 10 }, () => Promise.withResolvers<void>());
    const holders = entered.map((barrier) =>
      database.run(
        transaction(
          Effect.gen(function* () {
            yield* database.pg`SELECT pg_backend_pid()`;
            yield* Effect.sync(() => barrier.resolve());
            yield* Effect.promise(() => release.promise);
          }),
        ),
      ),
    );
    await Promise.all(entered.map((barrier) => barrier.promise));
    return {
      release: release.resolve,
      completed: Promise.all(holders).then(() => undefined),
    };
  };

  const lockQueueTable = async (): Promise<{
    readonly release: () => void;
    readonly completed: Promise<void>;
  }> => {
    const database = observer();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed = database.run(
      transaction(
        Effect.gen(function* () {
          yield* database.pg`LOCK TABLE pgboss.job IN ACCESS EXCLUSIVE MODE`;
          yield* Effect.sync(() => entered.resolve());
          yield* Effect.promise(() => release.promise);
        }),
      ),
    );
    await entered.promise;
    return { release: release.resolve, completed };
  };

  const blockedQueueInsertPid = () => {
    const database = observer();
    return database.run(
      single(
        Schema.Struct({ pid: Schema.NullOr(Schema.Int) }),
        database.pg`
          SELECT (
            SELECT pid
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND application_name = '@effect/sql-pg'
              AND wait_event_type = 'Lock'
              AND query ILIKE '%insert%pgboss%job%'
            LIMIT 1
          )::integer AS pid
        `,
      ).pipe(
        Effect.repeat({ until: (result) => result.pid !== null }),
        Effect.timeout("3 seconds"),
        Effect.flatMap((result) =>
          result.pid === null
            ? Effect.die(new Error("The create transaction did not reach the queue insert"))
            : Effect.succeed(result.pid),
        ),
      ),
    );
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    application = await startRuntime(postgres.databaseUrl, configuration);
    control = await startRuntime(postgres.databaseUrl, configuration);
  }, 120_000);

  afterAll(async () => {
    await control?.close();
    await application?.close();
    await postgres?.close();
  });

  beforeEach(async () => {
    sends.length = 0;
    await app().reset();
  });

  it("fails a mutation closed when every application connection is checked out", async () => {
    const created = await create("pool-exhaustion-create");
    const challengeId = challengeIdFrom(created);
    await observer().run(
      observer()
        .pg`UPDATE otp_router.challenges SET next_user_send_at = clock_timestamp() - interval '1 second' WHERE id::text = ${challengeId}`,
    );
    const pool = await holdApplicationPool();
    try {
      const result = await Effect.runPromise(
        app()
          .router.deliver({
            key: "pool-exhaustion-resend",
            challengeId,
            input: { action: "resend" },
            requestId: randomUUID(),
          })
          .pipe(Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "temporarily_unavailable" },
      });
      expect(await state()).toEqual({
        challenges: 1,
        secrets: 1,
        deliveries: 1,
        pending: 1,
        reserved: 0,
        operations: 1,
        createQuotas: 1,
        sendQuotas: 0,
        jobs: 1,
        sendCount: 0,
      });
      expect(sends).toHaveLength(0);
    } finally {
      pool.release();
      await pool.completed;
    }

    const retried = await Effect.runPromise(
      app().router.deliver({
        key: "pool-exhaustion-resend",
        challengeId,
        input: { action: "resend" },
        requestId: randomUUID(),
      }),
    );
    expect(retried.replayed).toBe(false);
    expect(await state()).toMatchObject({ deliveries: 2, operations: 2, jobs: 2 });
    if (!("deliveryId" in retried.body)) throw new Error("Expected a delivery result");
    await app().run(
      dispatch(app().configuration, {
        version: 1,
        deliveryId: retried.body.deliveryId,
        routingRevision: 2,
      }),
    );
    expect(sends).toHaveLength(1);
    expect((await state()).reserved).toBe(1);
  }, 10_000);

  it("rolls back a create transaction whose connection dies during queue insertion", async () => {
    const operationKey = "terminated-create-transaction";
    const queueLock = await stage("queue lock", lockQueueTable());
    try {
      const attempted = Effect.runPromise(
        app()
          .router.create({ key: operationKey, input: createInput, requestId: randomUUID() })
          .pipe(Effect.exit),
      );
      const pid = await stage("wait for blocked queue insert", blockedQueueInsertPid());
      expect(
        await stage(
          "uncommitted challenge count",
          observer().run(
            rows(
              Schema.Struct({ count: Schema.Int }),
              observer().pg`SELECT count(*)::integer AS count FROM otp_router.challenges`,
            ),
          ),
        ),
      ).toEqual([{ count: 0 }]);
      expect(
        await stage(
          "terminate blocked backend",
          observer().run(
            single(
              Schema.Struct({ terminated: Schema.Boolean }),
              observer().pg`SELECT pg_terminate_backend(${pid}) AS terminated`,
            ),
          ),
        ),
      ).toEqual({ terminated: true });
      const failed = await stage("await failed create", attempted);
      expect(Exit.isFailure(failed)).toBe(true);
    } finally {
      queueLock.release();
      await stage("release queue lock", queueLock.completed);
    }

    expect(await stage("rolled back state", state())).toEqual({
      challenges: 0,
      secrets: 0,
      deliveries: 0,
      pending: 0,
      reserved: 0,
      operations: 0,
      createQuotas: 0,
      sendQuotas: 0,
      jobs: 0,
      sendCount: 0,
    });
    expect(sends).toHaveLength(0);

    const recovered = await create(operationKey);
    expect(recovered.replayed).toBe(false);
    const replay = await create(operationKey);
    expect(replay.replayed).toBe(true);
    expect(challengeIdFrom(replay)).toBe(challengeIdFrom(recovered));
    expect(replay.body).toEqual(recovered.body);
    expect(await state()).toMatchObject({
      challenges: 1,
      secrets: 1,
      deliveries: 1,
      pending: 1,
      operations: 1,
      createQuotas: 1,
      jobs: 1,
      sendCount: 0,
    });
    expect(sends).toHaveLength(0);

    await app().run(
      dispatch(app().configuration, {
        version: 1,
        deliveryId: await deliveryIdFrom(recovered),
        routingRevision: 1,
      }),
    );
    expect(sends).toHaveLength(1);
  });
});
