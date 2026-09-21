import { DeliveryEvent, type Snapshot as DeliverySnapshot } from "@otp-router/engine/delivery";
import { Webhook } from "standardwebhooks";
import { PgClient } from "@effect/sql-pg";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { Data, Effect, Schema } from "effect";
import { ChallengeEvent, type Snapshot } from "@otp-router/engine/challenges";

export class InvalidWebhook extends Data.TaggedError("InvalidWebhook")<{}> {}

// Install these tables in the receiver's own application database via its migrations.
export const initializeReceiver = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE webhook_receipts(event_id uuid PRIMARY KEY, body text NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp())`;
  yield* sql`CREATE TABLE webhook_deliveries(operation_id uuid PRIMARY KEY, revision integer NOT NULL, snapshot jsonb NOT NULL)`;
  yield* sql`CREATE TABLE webhook_challenges(challenge_id uuid PRIMARY KEY, revision integer NOT NULL, snapshot jsonb NOT NULL)`;
});

// Use this same conditional write for the creation HTTP response. A webhook may
// already have stored a newer revision before that response arrives.
export const applySnapshot = (snapshot: Snapshot) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`INSERT INTO webhook_challenges(challenge_id,revision,snapshot) VALUES (${snapshot.challengeId},${snapshot.revision},${sql.json(snapshot)}) ON CONFLICT (challenge_id) DO UPDATE SET revision = EXCLUDED.revision, snapshot = EXCLUDED.snapshot WHERE webhook_challenges.revision < EXCLUDED.revision`;
  });

export const receiveWebhook = (input: {
  readonly secret: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const value = yield* Effect.try({
      // Pass exact raw UTF-8 body bytes, never JSON.parse/stringify before verify().
      try: () => new Webhook(input.secret).verify(input.body, input.headers),
      catch: () => new InvalidWebhook(),
    });
    const event = yield* Schema.decodeUnknownEffect(Schema.Union([ChallengeEvent, DeliveryEvent]))(
      value,
      {
        onExcessProperty: "error",
      },
    );
    if (event.eventId !== input.headers["webhook-id"])
      return yield* Effect.fail(new InvalidWebhook());
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { fresh } = yield* SqlSchema.findOne({
          Request: Schema.Void,
          Result: Schema.Struct({ fresh: Schema.Boolean }),
          execute: () =>
            sql`WITH receipt AS (INSERT INTO webhook_receipts(event_id,body) VALUES (${event.eventId},${input.body}) ON CONFLICT DO NOTHING RETURNING event_id) SELECT EXISTS(SELECT 1 FROM receipt) AS fresh`,
        })(undefined);
        if (fresh) {
          if (event.type === "challenge.updated") yield* applySnapshot(event.challenge);
          else yield* applyDeliverySnapshot(event.delivery);
        }
      }),
    );
  });

export const applyDeliverySnapshot = (snapshot: DeliverySnapshot) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`INSERT INTO webhook_deliveries(operation_id,revision,snapshot) VALUES (${snapshot.operationId},${snapshot.revision},${sql.json(snapshot)}) ON CONFLICT(operation_id) DO UPDATE SET revision=EXCLUDED.revision,snapshot=EXCLUDED.snapshot WHERE webhook_deliveries.revision < EXCLUDED.revision`;
  });
