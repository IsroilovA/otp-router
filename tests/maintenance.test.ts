import { randomUUID } from "node:crypto";
import { Effect, Redacted, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, invalidateRestoredChallenges } from "../src/challenges/cleanup.js";
import { createChallenge } from "../src/challenges/create.js";
import type { KeyRing } from "../src/challenges/crypto.js";
import { quotaRetryAt, sendLimits } from "../src/challenges/quotas.js";
import type { Configuration, RuntimeConfiguration, Settings } from "../src/config/config.js";
import { validateDeploymentIdentity, validateStoredKeys } from "../src/database/compatibility.js";
import { rows } from "../src/database/query.js";
import { FakeProvider, ProviderInstanceIdSchema } from "../src/providers/index.js";
import {
  challengeIdFrom,
  type IntegrationRuntime,
  type PostgresFixture,
  startPostgres,
  startRuntime,
} from "./fixture.js";

const key = (byte: number): string => Buffer.alloc(32, byte).toString("base64url");
const keyRing = (id: string, byte: number) => ({ active: id, keys: { [id]: key(byte) } });

const configuration: Configuration = {
  settings: {
    crypto: {
      deploymentId: "maintenance-tests",
      encryption: keyRing("enc-old", 1),
      verification: keyRing("verify-old", 2),
      fingerprint: keyRing("fingerprint-old", 3),
      recipientKey: key(4),
    },
    apiKeys: ["maintenance-tests-api-key-32-characters-long"],
    defaultLocale: "en",
    fallbackLocales: [],
    policies: { login: { providerInstanceIds: ["fake"] } },
    purposes: { login: ["login"] },
    deploymentSendLimit15m: 2,
    deploymentSendLimit24h: 3,
    recipientCreateLimit15m: 5,
    recipientSendLimit15m: 10,
    recipientGuessLimit15m: 10,
  },
  providers: [
    FakeProvider.make({
      instanceId: Schema.decodeUnknownSync(ProviderInstanceIdSchema)("fake"),
      enabled: true,
      settingsFingerprint: "maintenance-fake-v1",
      config: { outcome: "accepted", callbackSecret: Redacted.make("callback-secret") },
      templates: {},
    }),
  ],
};

const rotatedSettings = (settings: Settings): Settings => ({
  ...settings,
  crypto: {
    ...settings.crypto,
    encryption: {
      active: "enc-new",
      keys: { ...settings.crypto.encryption.keys, "enc-new": key(11) },
    },
    verification: {
      active: "verify-new",
      keys: { ...settings.crypto.verification.keys, "verify-new": key(12) },
    },
    fingerprint: {
      active: "fingerprint-new",
      keys: { ...settings.crypto.fingerprint.keys, "fingerprint-new": key(13) },
    },
  },
});

const activeOnly = (ring: KeyRing): KeyRing => {
  const value = ring.keys[ring.active];
  if (value === undefined) throw new Error("The active test key is missing");
  return { active: ring.active, keys: { [ring.active]: value } };
};

const omitRetainedKey = (
  settings: Settings,
  purpose: "encryption" | "verification" | "fingerprint",
): Settings => {
  const rotated = rotatedSettings(settings);
  switch (purpose) {
    case "encryption":
      return {
        ...rotated,
        crypto: { ...rotated.crypto, encryption: activeOnly(rotated.crypto.encryption) },
      };
    case "verification":
      return {
        ...rotated,
        crypto: { ...rotated.crypto, verification: activeOnly(rotated.crypto.verification) },
      };
    case "fingerprint":
      return {
        ...rotated,
        crypto: { ...rotated.crypto, fingerprint: activeOnly(rotated.crypto.fingerprint) },
      };
  }
};

const createInput = {
  recipient: { type: "phone" as const, phoneNumber: "+998901234567" },
  purpose: "login",
  contextId: "maintenance-session",
  policyId: "login",
};

describe("database compatibility and maintenance", () => {
  let database: PostgresFixture | undefined;
  let runtime: IntegrationRuntime | undefined;

  const current = (): IntegrationRuntime => {
    if (runtime === undefined) throw new Error("Maintenance runtime is not initialized");
    return runtime;
  };

  const create = (operationKey: string) =>
    Effect.runPromise(
      current().router.create({ key: operationKey, input: createInput, requestId: randomUUID() }),
    );

  beforeAll(async () => {
    database = await startPostgres();
    runtime = await startRuntime(database.databaseUrl, configuration);
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    await database?.close();
  });

  beforeEach(async () => {
    const harness = current();
    await harness.reset();
    await harness.run(
      harness.pg`DELETE FROM otp_router.deployment_identity WHERE singleton = true`,
    );
  });

  it("rejects removal of every retained crypto key purpose", async () => {
    await create("retained-key-references");
    for (const purpose of ["encryption", "verification", "fingerprint"] as const) {
      const result = await current().run(
        Effect.result(
          validateStoredKeys(omitRetainedKey(current().configuration.settings, purpose)),
        ),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "retained_key_missing" },
      });
    }
  });

  it("replays an operation after fingerprint rotation while the old key is retained", async () => {
    const operationKey = "fingerprint-rotation-replay";
    const first = await create(operationKey);
    const rotated: RuntimeConfiguration = {
      ...current().configuration,
      settings: rotatedSettings(current().configuration.settings),
    };
    await current().run(validateStoredKeys(rotated.settings));
    const replay = await current().run(
      createChallenge(rotated, {
        key: operationKey,
        input: createInput,
        requestId: randomUUID(),
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);
    expect(challengeIdFrom(replay)).toBe(challengeIdFrom(first));
  });

  it("requires invalidation and an elapsed quota window before adopting a recipient key", async () => {
    const harness = current();
    await harness.run(validateDeploymentIdentity(harness.configuration.settings));
    await create("recipient-key-adoption");
    const changed: Settings = {
      ...harness.configuration.settings,
      crypto: { ...harness.configuration.settings.crypto, recipientKey: key(20) },
    };

    expect(await harness.run(Effect.result(validateDeploymentIdentity(changed)))).toMatchObject({
      _tag: "Failure",
      failure: { reason: "recipient_key_changed_requires_incident_procedure" },
    });
    expect(
      await harness.run(Effect.result(validateDeploymentIdentity(changed, true))),
    ).toMatchObject({
      _tag: "Failure",
      failure: { reason: "recipient_key_change_requires_invalidation_and_quota_wait" },
    });

    expect(await harness.run(invalidateRestoredChallenges)).toBe(1);
    expect(
      await harness.run(Effect.result(validateDeploymentIdentity(changed, true))),
    ).toMatchObject({
      _tag: "Failure",
      failure: { reason: "recipient_key_change_requires_invalidation_and_quota_wait" },
    });
    expect(
      await harness.run(
        rows(
          Schema.Struct({ verification_state: Schema.String }),
          harness.pg`SELECT verification_state FROM otp_router.challenges`,
        ),
      ),
    ).toEqual([{ verification_state: "cancelled" }]);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ state: Schema.String }),
          harness.pg`SELECT state FROM otp_router.deliveries`,
        ),
      ),
    ).toEqual([{ state: "suppressed" }]);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ count: Schema.Int }),
          harness.pg`SELECT count(*)::integer AS count FROM otp_router.challenge_secrets`,
        ),
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ count: Schema.Int }),
          harness.pg`SELECT count(*)::integer AS count FROM otp_router.quota_events WHERE kind = 'create'`,
        ),
      ),
    ).toEqual([{ count: 1 }]);

    await harness.run(
      harness.pg`UPDATE otp_router.quota_events SET occurred_at = clock_timestamp() - interval '24 hours 1 second' WHERE kind = 'create'`,
    );
    await harness.run(validateDeploymentIdentity(changed, true));
    await harness.run(validateDeploymentIdentity(changed));
  });

  it("expires challenges during cleanup while retaining live quota usage", async () => {
    const harness = current();
    const created = await create("cleanup-expiry");
    const challengeId = challengeIdFrom(created);
    await harness.run(
      harness.pg`UPDATE otp_router.challenges SET expires_at = clock_timestamp() - interval '1 second' WHERE id::text = ${challengeId}`,
    );
    await harness.run(cleanup);

    expect(
      await harness.run(
        rows(
          Schema.Struct({ verification_state: Schema.String }),
          harness.pg`SELECT verification_state FROM otp_router.challenges WHERE id::text = ${challengeId}`,
        ),
      ),
    ).toEqual([{ verification_state: "expired" }]);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ state: Schema.String }),
          harness.pg`SELECT state FROM otp_router.deliveries WHERE challenge_id::text = ${challengeId}`,
        ),
      ),
    ).toEqual([{ state: "suppressed" }]);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ count: Schema.Int }),
          harness.pg`SELECT count(*)::integer AS count FROM otp_router.challenge_secrets WHERE challenge_id::text = ${challengeId}`,
        ),
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ count: Schema.Int }),
          harness.pg`SELECT count(*)::integer AS count FROM otp_router.quota_events WHERE kind = 'create'`,
        ),
      ),
    ).toEqual([{ count: 1 }]);
  });

  it("drains every full cleanup batch in one sweep", async () => {
    const harness = current();
    const created = await create("cleanup-full-batches");
    const sourceChallengeId = challengeIdFrom(created);
    const contextPrefix = `cleanup-batch-${randomUUID()}-`;
    const quotaIdentity = `cleanup-batch-${randomUUID()}`;

    await harness.run(
      harness.pg`
        WITH source AS (
          SELECT c.*, s.phone, s.code, s.verifier
          FROM otp_router.challenges c
          JOIN otp_router.challenge_secrets s ON s.challenge_id = c.id
          WHERE c.id::text = ${sourceChallengeId}
        ), seed AS MATERIALIZED (
          SELECT gen_random_uuid() AS clone_id, series.value, source.*
          FROM source
          CROSS JOIN generate_series(1, 205) AS series(value)
        ), inserted AS (
          INSERT INTO otp_router.challenges (
            id, purpose, context_id, recipient_token, policy_id, snapshot,
            verification_state, verification_id, verified_at, created_at, expires_at,
            terminal_at, incorrect_guesses, send_count, routing_revision,
            automatic_stopped, current_delivery_id, next_user_send_at
          )
          SELECT
            clone_id, purpose, ${contextPrefix} || value::text, recipient_token, policy_id,
            snapshot, 'active', NULL, NULL, created_at,
            clock_timestamp() - interval '1 minute', NULL, incorrect_guesses, send_count,
            routing_revision, false, current_delivery_id, next_user_send_at
          FROM seed
          RETURNING id
        )
        INSERT INTO otp_router.challenge_secrets(challenge_id, phone, code, verifier)
        SELECT inserted.id, source.phone, source.code, source.verifier
        FROM inserted
        CROSS JOIN source
      `,
    );
    await harness.run(
      harness.pg`INSERT INTO otp_router.quota_keys(identity) VALUES (${quotaIdentity})`,
    );
    await harness.run(
      harness.pg`
        INSERT INTO otp_router.quota_events(identity, kind, event_id, occurred_at)
        SELECT ${quotaIdentity}, 'send', gen_random_uuid(), clock_timestamp() - interval '25 hours'
        FROM generate_series(1, 1005)
        UNION ALL
        SELECT ${quotaIdentity}, 'send', gen_random_uuid(), clock_timestamp()
      `,
    );

    await harness.run(cleanup);

    expect(
      await harness.run(
        rows(
          Schema.Struct({ active_expired: Schema.Int, expired_clones: Schema.Int }),
          harness.pg`
            SELECT
              count(*) FILTER (
                WHERE verification_state = 'active' AND expires_at <= clock_timestamp()
              )::integer AS active_expired,
              count(*) FILTER (
                WHERE verification_state = 'expired' AND context_id LIKE ${`${contextPrefix}%`}
              )::integer AS expired_clones
            FROM otp_router.challenges
          `,
        ),
      ),
    ).toEqual([{ active_expired: 0, expired_clones: 205 }]);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ count: Schema.Int }),
          harness.pg`
            SELECT count(*)::integer AS count
            FROM otp_router.challenge_secrets s
            JOIN otp_router.challenges c ON c.id = s.challenge_id
            WHERE c.context_id LIKE ${`${contextPrefix}%`}
          `,
        ),
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ old_count: Schema.Int, live_count: Schema.Int }),
          harness.pg`
            SELECT
              count(*) FILTER (
                WHERE occurred_at <= clock_timestamp() - interval '24 hours'
              )::integer AS old_count,
              count(*) FILTER (
                WHERE occurred_at > clock_timestamp() - interval '24 hours'
              )::integer AS live_count
            FROM otp_router.quota_events
            WHERE identity = ${quotaIdentity}
          `,
        ),
      ),
    ).toEqual([{ old_count: 0, live_count: 1 }]);
  });

  it("retains expired operation results for live work and safely reuses the key after cleanup", async () => {
    const harness = current();
    const operationKey = "retained-create-operation";
    const first = await create(operationKey);
    const firstChallengeId = challengeIdFrom(first);
    await harness.run(
      harness.pg`UPDATE otp_router.idempotency_records SET created_at = clock_timestamp() - interval '25 hours', retain_until = clock_timestamp() - interval '1 hour' WHERE challenge_id::text = ${firstChallengeId}`,
    );

    await harness.run(cleanup);
    const activeReplay = await create(operationKey);
    expect(activeReplay.replayed).toBe(true);
    expect(challengeIdFrom(activeReplay)).toBe(firstChallengeId);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ count: Schema.Int }),
          harness.pg`SELECT count(*)::integer AS count FROM otp_router.idempotency_records WHERE challenge_id::text = ${firstChallengeId}`,
        ),
      ),
    ).toEqual([{ count: 1 }]);

    await harness.run(
      harness.pg`UPDATE otp_router.deliveries SET state = 'dispatching', reserved_at = clock_timestamp(), acceptance = 'unknown' WHERE challenge_id::text = ${firstChallengeId} AND state = 'pending'`,
    );
    await Effect.runPromise(
      harness.router.cancel({
        key: "cancel-retained-operation",
        challengeId: firstChallengeId,
        requestId: randomUUID(),
        input: {},
      }),
    );
    await harness.run(
      harness.pg`UPDATE otp_router.challenges SET terminal_at = clock_timestamp() - interval '8 days' WHERE id::text = ${firstChallengeId}`,
    );
    await harness.run(
      harness.pg`UPDATE otp_router.idempotency_records SET created_at = clock_timestamp() - interval '25 hours', retain_until = clock_timestamp() - interval '1 hour' WHERE challenge_id::text = ${firstChallengeId}`,
    );

    await harness.run(cleanup);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ verification_state: Schema.String }),
          harness.pg`SELECT verification_state FROM otp_router.challenges WHERE id::text = ${firstChallengeId}`,
        ),
      ),
    ).toEqual([{ verification_state: "cancelled" }]);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ count: Schema.Int }),
          harness.pg`SELECT count(*)::integer AS count FROM otp_router.idempotency_records WHERE challenge_id::text = ${firstChallengeId}`,
        ),
      ),
    ).toEqual([{ count: 2 }]);

    await harness.run(
      harness.pg`UPDATE otp_router.deliveries SET state = 'failed', acceptance = 'not_accepted', completed_at = clock_timestamp() WHERE challenge_id::text = ${firstChallengeId} AND state = 'dispatching'`,
    );
    await harness.run(cleanup);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ challenges: Schema.Int, operations: Schema.Int }),
          harness.pg`SELECT (SELECT count(*) FROM otp_router.challenges WHERE id::text = ${firstChallengeId})::integer AS challenges, (SELECT count(*) FROM otp_router.idempotency_records WHERE challenge_id::text = ${firstChallengeId})::integer AS operations`,
        ),
      ),
    ).toEqual([{ challenges: 0, operations: 0 }]);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ count: Schema.Int }),
          harness.pg`SELECT count(*)::integer AS count FROM otp_router.quota_events WHERE kind = 'create'`,
        ),
      ),
    ).toEqual([{ count: 1 }]);

    const reused = await create(operationKey);
    expect(reused.replayed).toBe(false);
    expect(challengeIdFrom(reused)).not.toBe(firstChallengeId);
    expect(
      await harness.run(
        rows(
          Schema.Struct({ id: Schema.String, verification_state: Schema.String }),
          harness.pg`SELECT id, verification_state FROM otp_router.challenges`,
        ),
      ),
    ).toEqual([{ id: challengeIdFrom(reused), verification_state: "active" }]);
  });

  it("uses the latest retry time across the 15-minute and 24-hour deployment windows", async () => {
    const harness = current();
    const now = new Date("2030-01-02T12:00:00.000Z");
    await harness.run(
      harness.pg`INSERT INTO otp_router.quota_keys(identity) VALUES ('deployment')`,
    );
    for (const occurredAt of [
      new Date(now.getTime() - 86_400_000),
      new Date(now.getTime() - 23 * 3_600_000),
      new Date(now.getTime() - 10 * 60_000),
      new Date(now.getTime() - 5 * 60_000),
    ]) {
      await harness.run(
        harness.pg`INSERT INTO otp_router.quota_events(identity,kind,event_id,occurred_at) VALUES ('deployment','send',${randomUUID()},${occurredAt})`,
      );
    }
    const limits = sendLimits(harness.configuration.settings, "unused-recipient", "fake");
    expect(await harness.run(quotaRetryAt(limits, now))).toBe("2030-01-02T13:00:00.000Z");
    expect(
      await harness.run(quotaRetryAt(limits, new Date("2030-01-02T13:00:00.000Z"))),
    ).toBeUndefined();
  });
});
