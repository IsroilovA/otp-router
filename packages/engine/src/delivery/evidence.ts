import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Operation, Attempt } from "./records.js";
import type { Outcome } from "./decision.js";

export const appendEvidence = (
  operation: Operation,
  attempt: Attempt,
  outcome: Outcome,
  time: Date,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = randomUUID();
    const body = {
      eventId: id,
      projectId: operation.project_id,
      type: "attempt.evidence",
      operationId: operation.id,
      attemptId: attempt.id,
      occurredAt: time.toISOString(),
      evidence: {
        state: outcome.state,
        acceptance: outcome.acceptance,
        diagnosticCode: outcome.diagnosticCode ?? null,
        providerEventTime: outcome.providerEventTime ?? null,
      },
    };
    yield* sql`INSERT INTO otp_router.events(id,project_id,subject_id,operation_id,kind,revision,occurred_at,body) VALUES (${id},${operation.project_id},${attempt.id},${operation.id},'attempt.evidence',(SELECT COALESCE(MAX(revision),0)+1 FROM otp_router.events WHERE subject_id = ${attempt.id} AND kind = 'attempt.evidence'),${time},${JSON.stringify(body)})`;
    yield* sql`UPDATE otp_router.delivery_operations SET history_updated_at = ${time} WHERE id = ${operation.id}`;
  });
