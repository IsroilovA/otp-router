import { changed } from "./changes.js";
import { deliveryTransaction as transaction } from "./transaction.js";
import { SqlClient } from "effect/unstable/sql";
import { Cause, Effect, Exit, Schema } from "effect";
import { providerDiagnostic } from "../providers/diagnostics.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import {
  OperationIdSchema,
  AttemptIdSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  NormalizedPhoneSchema,
  OtpCodeSchema,
  type ProviderSendError,
  type ReadyProvider,
} from "../providers/contract.js";
import { logEvent } from "../diagnostics/log.js";
import { count, duration } from "../diagnostics/metrics.js";
import { decrypt, type Ciphertext } from "../crypto.js";
import {
  extendAdmission,
  checkQuotas,
  commonSendLimits,
  countQuotas,
  lockQuotas,
  sendLimits,
} from "../delivery/quotas.js";
import { expire, findOperation, findAttempt, findSecrets } from "./store.js";
import type { Operation, Attempt } from "./records.js";
import type { DeliveryJob } from "../queue/jobs.js";
import { availableProviders } from "./eligibility.js";
import { recordAccepted } from "./callbacks.js";
import { mergeLockedOutcome, recordOutcome, type Outcome } from "./outcomes.js";

const stale = (operation: Operation, delivery: Attempt, job: DeliveryJob) =>
  operation.state !== "active" ||
  operation.routing_revision !== delivery.routing_revision ||
  job.routingRevision !== delivery.routing_revision ||
  (delivery.reason === "fallback" && operation.automatic_stopped);
export const dispatchGate = (config: RuntimeConfiguration, job: DeliveryJob) =>
  transaction(
    config,
    Effect.gen(function* () {
      const initial = yield* findAttempt(job.attemptId);
      const original = yield* findOperation(initial.operation_id);
      const limits = sendLimits(
        config.settings,
        original.recipient_token,
        initial.provider_instance_id,
      );
      yield* lockQuotas(limits);
      const locked = yield* findOperation(original.id, true);
      const gateMonotonicTime = performance.now();
      const time = yield* databaseTime;
      const operation = yield* expire(locked, time);
      const delivery = yield* findAttempt(initial.id);
      yield* duration("queue", Math.max(0, time.getTime() - delivery.due_at.getTime()));
      const sql = yield* SqlClient.SqlClient;
      if (delivery.state === "dispatching") {
        if (operation.state === "active") yield* changed(operation.id);
        yield* count("recovery", "uncertain");
        yield* sql`UPDATE otp_router.delivery_attempts SET state = 'uncertain', acceptance = 'unknown', diagnostic_code = 'worker_recovery' WHERE id = ${delivery.id} AND state = 'dispatching'`;
        return undefined;
      }
      if (delivery.state !== "pending") return undefined;
      if (stale(operation, delivery, job)) {
        yield* count("suppressed", "ineligible");
        yield* sql`UPDATE otp_router.delivery_attempts SET state = 'suppressed' WHERE id = ${delivery.id} AND state = 'pending'`;
        return undefined;
      }
      yield* sql`UPDATE otp_router.delivery_operations SET processing_started = true WHERE id = ${operation.id}`;
      yield* changed(operation.id);
      const sharedBudget = yield* checkQuotas(
        commonSendLimits(config.settings, operation.recipient_token),
        time,
      ).pipe(
        Effect.as(true),
        Effect.catchTag("DomainError", () => Effect.succeed(false)),
      );
      if (!sharedBudget || operation.send_count >= operation.snapshot.maxSends) {
        yield* count("suppressed", "rate_limited");
        yield* sql`UPDATE otp_router.delivery_attempts SET state = 'suppressed', diagnostic_code = 'rate_limited' WHERE id = ${delivery.id}`;
        return undefined;
      }
      const target = (yield* availableProviders(config, operation, time)).find(
        ({ provider }) => provider.providerInstanceId === delivery.provider_instance_id,
      );
      if (target === undefined || target.retryAt !== undefined) {
        // No provider call occurred. Only this instance is blocked, so the route can advance.
        yield* mergeLockedOutcome(config, operation, delivery, {
          state: "failed",
          acceptance: "not_accepted",
          diagnosticCode: target === undefined ? "provider_unavailable" : "rate_limited",
        });
        return undefined;
      }
      const saved = target.provider;
      const secrets = yield* findSecrets(operation.id);
      const attached = yield* attachedCiphertext(secrets.code);
      const recipient = yield* Schema.decodeUnknownEffect(NormalizedPhoneSchema)(
        yield* decrypt(config.settings.crypto, operation.id, "phone", secrets.phone),
      );
      const code = yield* Schema.decodeUnknownEffect(OtpCodeSchema)(
        yield* decrypt(config.settings.crypto, operation.id, "code", attached),
      );
      const input = {
        operationId: yield* Schema.decodeUnknownEffect(OperationIdSchema)(operation.id),
        attemptId: yield* Schema.decodeUnknownEffect(AttemptIdSchema)(delivery.id),
        recipient,
        code,
        expiresAt: yield* Schema.decodeUnknownEffect(IsoDateTimeSchema)(
          operation.expires_at.toISOString(),
        ),
        locale: yield* Schema.decodeUnknownEffect(LocaleSchema)(saved.resolvedLocale),
        template: saved.template,
        remainingDeliveryMs: Math.max(
          0,
          operation.expires_at.getTime() - time.getTime() - saved.sendTimeoutMs,
        ),
        ...(config.providers.get(saved.providerInstanceId)?.idempotency.supported === true
          ? { providerIdempotencyKey: delivery.id }
          : {}),
      };
      yield* countQuotas(limits, delivery.id, time);
      yield* extendAdmission(operation.recipient_token, delivery.id, time);
      // Allow outcome persistence time beyond the provider timeout before independent recovery.
      yield* sql`UPDATE otp_router.delivery_attempts SET state = 'dispatching', reserved_at = ${time}, recovery_at = ${new Date(time.getTime() + saved.sendTimeoutMs + 30000)}, acceptance = 'unknown' WHERE id = ${delivery.id} AND state = 'pending'`;
      yield* sql`UPDATE otp_router.delivery_operations SET send_count = send_count + 1, next_user_send_at = GREATEST(next_user_send_at,${new Date(time.getTime() + operation.snapshot.resendCooldownSeconds * 1000)}) WHERE id = ${operation.id}`;
      return {
        input,
        providerId: saved.providerInstanceId,
        gateMonotonicTime,
        minDeliveryWindowMs: saved.minDeliveryWindowMs,
        timeoutMs: Math.min(saved.sendTimeoutMs, operation.expires_at.getTime() - time.getTime()),
      };
    }),
  );
const failureOutcome = (
  cause: Cause.Cause<ProviderSendError | Cause.TimeoutError>,
  provider: ReadyProvider,
): Outcome => {
  const failure = Cause.findErrorOption(cause);
  if (
    Cause.hasDies(cause) ||
    Cause.hasInterrupts(cause) ||
    failure._tag === "None" ||
    failure.value._tag === "TimeoutError"
  )
    return { state: "uncertain", acceptance: "unknown", diagnosticCode: "interrupted_or_timeout" };
  const error = failure.value;
  return {
    state: error.acceptance === "not_accepted" ? "failed" : "uncertain",
    acceptance: error.acceptance,
    failureCategory: error._tag,
    diagnosticCode: providerDiagnostic(provider, error.diagnosticCode),
    ...(error.retryAt === undefined ? {} : { retryAt: new Date(error.retryAt) }),
    stop: error._tag === "InvalidRecipient",
  };
};
export const dispatch = (config: RuntimeConfiguration, job: DeliveryJob) =>
  Effect.gen(function* () {
    const reserved = yield* dispatchGate(config, job);
    if (reserved === undefined) return;
    const provider = config.providers.get(reserved.providerId);
    if (provider === undefined) return yield* Effect.die(new Error("Reserved provider missing"));
    // This is the only send invocation for this durable record. A failed/unknown commit never reaches here.
    yield* count("send", "reserved");
    const started = performance.now();
    const remainingDeliveryMs =
      reserved.input.remainingDeliveryMs - (started - reserved.gateMonotonicTime);
    if (remainingDeliveryMs <= reserved.minDeliveryWindowMs) {
      // The reservation remains counted after commit, even when local delay prevents transmission.
      yield* recordOutcome(config, job.attemptId, {
        state: "failed",
        acceptance: "not_accepted",
        diagnosticCode: "delivery_window_too_short",
      });
      return;
    }
    const exit = yield* provider
      .send({
        ...reserved.input,
        remainingDeliveryMs,
      })
      .pipe(Effect.timeout(reserved.timeoutMs), Effect.exit);
    yield* duration("provider", performance.now() - started);
    if (Exit.isSuccess(exit)) {
      yield* count("send", "accepted");
      yield* logEvent({
        event: "provider_send",
        attemptId: job.attemptId,
        providerInstanceId: reserved.providerId,
        outcome: "accepted",
        elapsedMilliseconds: performance.now() - started,
      });
      yield* recordAccepted(config, job.attemptId, exit.value);
      return;
    }
    const outcome = failureOutcome(exit.cause, provider);
    yield* count("send", outcome.state);
    yield* logEvent({
      event: "provider_send",
      attemptId: job.attemptId,
      providerInstanceId: reserved.providerId,
      outcome: outcome.state,
      elapsedMilliseconds: performance.now() - started,
    });
    yield* recordOutcome(config, job.attemptId, outcome);
    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
      return yield* Effect.failCause(exit.cause);
  });

const attachedCiphertext = (code: Ciphertext | null) =>
  code === null ? Effect.die(new Error("Active operation has no code")) : Effect.succeed(code);
