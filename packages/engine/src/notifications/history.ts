import { assertCapabilities } from "../config/deployment.js";
import { requireAccess } from "../projects/store.js";
import { AttemptSnapshot } from "../delivery/history-contracts.js";
import { IntegrationReference } from "../delivery/input.js";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { rows } from "../database/query.js";
import { RouterConfig } from "../config/runtime.js";
import { DomainError } from "../errors.js";
import { digest, equalDigest, type CryptoConfig } from "../crypto.js";
import { findProjectOperation } from "../delivery/store.js";
import { DeliveryHistory, HistoryEvent, PageInput } from "./history-contracts.js";

const Cursor = Schema.Struct({
  project: Schema.String,
  filter: Schema.String,
  after: Schema.String,
  ceiling: Schema.String,
  keyId: Schema.String,
  signature: Schema.String,
});
const encodeCursor = (
  crypto: CryptoConfig,
  {
    project,
    filter,
    after,
    ceiling,
  }: {
    readonly project: string;
    readonly filter: string;
    readonly after: string;
    readonly ceiling: string;
  },
) => {
  const signature = digest(crypto.fingerprint, ["history-cursor", project, filter, after, ceiling]);
  return Buffer.from(
    JSON.stringify({
      project,
      filter,
      after,
      ceiling,
      keyId: signature.keyId,
      signature: signature.value,
    }),
  ).toString("base64url");
};
const decodeCursor = (crypto: CryptoConfig, value: string, project: string, filter: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))(
    Buffer.from(value, "base64url").toString("utf8"),
  ).pipe(
    Effect.mapError(() => new DomainError({ code: "invalid_request" })),
    Effect.flatMap((cursor) => {
      if (
        cursor.project !== project ||
        cursor.filter !== filter ||
        crypto.fingerprint.keys[cursor.keyId] === undefined ||
        !equalDigest(
          cursor.signature,
          digest(
            crypto.fingerprint,
            ["history-cursor", project, filter, cursor.after, cursor.ceiling],
            cursor.keyId,
          ).value,
        )
      )
        return Effect.fail(new DomainError({ code: "invalid_request" }));
      return Effect.succeed(cursor);
    }),
  );
const invalid = () => new DomainError({ code: "invalid_request" });

const readWindow = (
  crypto: CryptoConfig,
  project: string,
  options: {
    readonly input: typeof PageInput.Type;
    readonly filter: string;
    readonly feed: boolean;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stream = (yield* rows(
      Schema.Struct({ head: Schema.String, floor: Schema.String }),
      sql`SELECT head::text,floor::text FROM otp_router.project_streams WHERE project_id = ${project} FOR SHARE`,
    ))[0];
    const head = stream?.head ?? "0",
      floor = stream?.floor ?? "0";
    const cursor =
      options.input.cursor === undefined
        ? undefined
        : yield* decodeCursor(crypto, options.input.cursor, project, options.filter);
    const after = cursor?.after ?? (options.feed ? floor : "0");
    if (!/^\d+$/u.test(after) || (cursor !== undefined && !/^\d+$/u.test(cursor.ceiling)))
      return yield* Effect.fail(invalid());
    if (options.feed && cursor !== undefined && BigInt(after) < BigInt(floor))
      return yield* Effect.fail(new DomainError({ code: "history_cursor_expired" }));
    const ceiling =
      cursor === undefined || (options.feed && cursor.after === cursor.ceiling)
        ? head
        : cursor.ceiling;
    return { after, ceiling };
  });

export const DeliveryHistoryLive = Layer.effect(
  DeliveryHistory,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* RouterConfig;
    const retentionMs = config.settings.historyRetentionDays * 86400000;
    const wrap = <A, E>(
      project: string,
      principalId: string,
      input: typeof PageInput.Type,
      effect: Effect.Effect<A, E, SqlClient.SqlClient>,
    ) =>
      Schema.decodeUnknownEffect(PageInput)(input).pipe(
        Effect.mapError(invalid),
        Effect.andThen(
          sql.withTransaction(
            assertCapabilities(config).pipe(
              Effect.andThen(requireAccess(project, principalId)),
              Effect.andThen(effect),
            ),
          ),
        ),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((error) =>
          error instanceof DomainError
            ? error
            : new DomainError({ code: "temporarily_unavailable" }),
        ),
      );
    const retainUntil = (terminal: Date | null, updated: Date) =>
      terminal === null
        ? null
        : new Date(Math.max(terminal.getTime(), updated.getTime()) + retentionMs).toISOString();
    return {
      events: (project, input, principalId) =>
        wrap(
          project,
          principalId,
          input,
          sql.withTransaction(
            Effect.gen(function* () {
              const filter = JSON.stringify([input.operationId ?? null, input.attemptId ?? null]);
              const { after, ceiling } = yield* readWindow(config.settings.crypto, project, {
                input,
                filter,
                feed: true,
              });
              const limit = input.limit ?? 100;
              const validId = Schema.is(Schema.String.check(Schema.isUUID()));
              const operationFilter =
                input.operationId === undefined
                  ? sql``
                  : validId(input.operationId)
                    ? sql`AND operation_id = ${input.operationId}`
                    : sql`AND false`;
              const attemptFilter =
                input.attemptId === undefined
                  ? sql``
                  : validId(input.attemptId)
                    ? sql`AND subject_id = ${input.attemptId}`
                    : sql`AND false`;
              const found = yield* rows(
                Schema.Struct({
                  body: Schema.fromJsonString(HistoryEvent),
                  stream_sequence: Schema.String,
                }),
                sql`SELECT body,stream_sequence::text FROM otp_router.events WHERE project_id = ${project} AND stream_sequence > ${after}::bigint AND stream_sequence <= ${ceiling}::bigint ${operationFilter} ${attemptFilter} ORDER BY stream_sequence LIMIT ${limit + 1}`,
              );
              const page = found.slice(0, limit),
                hasMore = found.length > limit;
              const next = hasMore ? (page.at(-1)?.stream_sequence ?? after) : ceiling;
              return {
                events: page.map((event) => event.body),
                hasMore,
                highWaterMark: ceiling,
                reconciliationDays: config.settings.historyRetentionDays,
                nextCursor: encodeCursor(config.settings.crypto, {
                  project: project,
                  filter: filter,
                  after: next,
                  ceiling: ceiling,
                }),
              };
            }),
          ),
        ),
      attempt: (project, id, principalId) =>
        wrap(
          project,
          principalId,
          {},
          Effect.gen(function* () {
            if (!Schema.is(Schema.String.check(Schema.isUUID()))(id))
              return yield* Effect.fail(new DomainError({ code: "operation_not_found" }));
            const found = yield* rows(
              Schema.Struct({ public_snapshot: AttemptSnapshot }),
              sql`SELECT a.public_snapshot FROM otp_router.delivery_attempts a JOIN otp_router.delivery_operations o ON o.id = a.operation_id WHERE o.project_id = ${project} AND a.id = ${id}`,
            );
            const attempt = found[0];
            if (attempt === undefined)
              return yield* Effect.fail(new DomainError({ code: "operation_not_found" }));
            return attempt.public_snapshot;
          }),
        ),
      attempts: (project, operationId, input, principalId) =>
        wrap(
          project,
          principalId,
          input,
          Effect.gen(function* () {
            const operation = yield* findProjectOperation(project, operationId);
            const filter = `attempts:${operationId}`;
            const { after, ceiling } = yield* readWindow(config.settings.crypto, project, {
              input,
              filter,
              feed: false,
            });
            const limit = input.limit ?? 100;
            const found = yield* rows(
              Schema.Struct({
                id: Schema.String,
                sequence: Schema.String,
                public_snapshot: AttemptSnapshot,
              }),
              sql`SELECT id,public_snapshot,creation_sequence::text AS sequence FROM otp_router.delivery_attempts WHERE operation_id = ${operation.id} AND creation_sequence > ${after}::bigint AND creation_sequence <= ${ceiling}::bigint ORDER BY creation_sequence LIMIT ${limit + 1}`,
            );
            const page = found.slice(0, limit),
              last = page.at(-1);
            return {
              attempts: page.map((row) => row.public_snapshot),
              retainUntil: retainUntil(operation.terminal_at, operation.history_updated_at),
              nextCursor:
                found.length > limit && last !== undefined
                  ? encodeCursor(config.settings.crypto, {
                      project: project,
                      filter: filter,
                      after: last.sequence,
                      ceiling,
                    })
                  : null,
            };
          }),
        ),
      operations: (project, input, principalId) =>
        wrap(
          project,
          principalId,
          input,
          Effect.gen(function* () {
            const { after, ceiling } = yield* readWindow(config.settings.crypto, project, {
              input,
              filter: "operations",
              feed: false,
            });
            const limit = input.limit ?? 100;
            const found = yield* rows(
              Schema.Struct({
                id: Schema.String,
                sequence: Schema.String,
                state: Schema.String,
                integration_reference: Schema.NullOr(IntegrationReference),
                created_at: Schema.Date,
                terminal_at: Schema.NullOr(Schema.Date),
                history_updated_at: Schema.Date,
              }),
              sql`SELECT id,state,integration_reference,created_at,terminal_at,history_updated_at,creation_sequence::text AS sequence FROM otp_router.delivery_operations WHERE project_id = ${project} AND creation_sequence > ${after}::bigint AND creation_sequence <= ${ceiling}::bigint ORDER BY creation_sequence LIMIT ${limit + 1}`,
            );
            const page = found.slice(0, limit),
              last = page.at(-1);
            return {
              operations: page.map((operation) => ({
                operationId: operation.id,
                projectId: project,
                state: operation.state,
                ...(operation.integration_reference === null
                  ? {}
                  : { integrationReference: operation.integration_reference }),
                createdAt: operation.created_at.toISOString(),
                completedAt: operation.terminal_at?.toISOString() ?? null,
                retainUntil: retainUntil(operation.terminal_at, operation.history_updated_at),
              })),
              nextCursor:
                found.length > limit && last !== undefined
                  ? encodeCursor(config.settings.crypto, {
                      project: project,
                      filter: "operations",
                      after: last.sequence,
                      ceiling,
                    })
                  : null,
            };
          }),
        ),
    };
  }),
);
