import { changed } from "../challenges/changes.js";
import { challengeTransaction as transaction } from "../challenges/transaction.js";
import { SqlClient } from "effect/unstable/sql";
import { Cause, Effect, Exit, Schema } from "effect";
import { providerDiagnostic } from "../providers/diagnostics.js";
import type { RuntimeConfiguration } from "../config/config.js";
import { databaseTime } from "../database/transaction.js";
import {
  ChallengeIdSchema,
  DeliveryIdSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  NormalizedPhoneSchema,
  OtpCodeSchema,
  type ProviderSendError,
  type ReadyProvider,
} from "../providers/contract.js";
import { logEvent } from "../diagnostics/log.js";
import { count, duration } from "../diagnostics/metrics.js";
import { decrypt } from "../challenges/crypto.js";
import {
  checkQuotas,
  commonSendLimits,
  countQuotas,
  lockQuotas,
  sendLimits,
} from "../challenges/quotas.js";
import { expire, findChallenge, findDelivery, findSecrets } from "../challenges/store.js";
import type { Challenge, Delivery } from "../challenges/records.js";
import type { DeliveryJob } from "../queue/jobs.js";
import { availableProviders } from "./eligibility.js";
import { recordAccepted } from "./callbacks.js";
import { mergeLockedOutcome, recordOutcome, type Outcome } from "./outcomes.js";

const stale = (challenge: Challenge, delivery: Delivery, job: DeliveryJob) =>
  challenge.verification_state !== "active" ||
  challenge.routing_revision !== delivery.routing_revision ||
  job.routingRevision !== delivery.routing_revision ||
  (delivery.reason === "fallback" && challenge.automatic_stopped);
export const dispatchGate = (config: RuntimeConfiguration, job: DeliveryJob) =>
  transaction(
    config,
    Effect.gen(function* () {
      const initial = yield* findDelivery(job.deliveryId);
      const original = yield* findChallenge(initial.challenge_id);
      const limits = sendLimits(
        config.settings,
        original.recipient_token,
        initial.provider_instance_id,
      );
      yield* lockQuotas(limits);
      const locked = yield* findChallenge(original.id, true);
      const gateMonotonicTime = performance.now();
      const time = yield* databaseTime;
      const challenge = yield* expire(locked, time);
      const delivery = yield* findDelivery(initial.id);
      yield* duration("queue", Math.max(0, time.getTime() - delivery.due_at.getTime()));
      const sql = yield* SqlClient.SqlClient;
      if (delivery.state === "dispatching") {
        if (challenge.verification_state === "active") yield* changed(challenge.id);
        yield* count("recovery", "uncertain");
        yield* sql`UPDATE otp_router.deliveries SET state = 'uncertain', acceptance = 'unknown', diagnostic_code = 'worker_recovery' WHERE id = ${delivery.id} AND state = 'dispatching'`;
        return undefined;
      }
      if (delivery.state !== "pending") return undefined;
      if (stale(challenge, delivery, job)) {
        yield* count("suppressed", "ineligible");
        yield* sql`UPDATE otp_router.deliveries SET state = 'suppressed' WHERE id = ${delivery.id} AND state = 'pending'`;
        return undefined;
      }
      yield* sql`UPDATE otp_router.challenges SET processing_started = true WHERE id = ${challenge.id}`;
      yield* changed(challenge.id);
      const sharedBudget = yield* checkQuotas(
        commonSendLimits(config.settings, challenge.recipient_token),
        time,
      ).pipe(
        Effect.as(true),
        Effect.catchTag("DomainError", () => Effect.succeed(false)),
      );
      if (!sharedBudget || challenge.send_count >= challenge.snapshot.maxSends) {
        yield* count("suppressed", "rate_limited");
        yield* sql`UPDATE otp_router.deliveries SET state = 'suppressed', diagnostic_code = 'rate_limited' WHERE id = ${delivery.id}`;
        return undefined;
      }
      const target = (yield* availableProviders(config, challenge, time)).find(
        ({ provider }) => provider.providerInstanceId === delivery.provider_instance_id,
      );
      if (target === undefined || target.retryAt !== undefined) {
        // No provider call occurred. Only this instance is blocked, so the route can advance.
        yield* mergeLockedOutcome(config, challenge, delivery, {
          state: "failed",
          acceptance: "not_accepted",
          diagnosticCode: target === undefined ? "provider_unavailable" : "rate_limited",
        });
        return undefined;
      }
      const saved = target.provider;
      const secrets = yield* findSecrets(challenge.id);
      const recipient = yield* Schema.decodeUnknownEffect(NormalizedPhoneSchema)(
        yield* decrypt(config.settings.crypto, challenge.id, "phone", secrets.phone),
      );
      const code = yield* Schema.decodeUnknownEffect(OtpCodeSchema)(
        yield* decrypt(config.settings.crypto, challenge.id, "code", secrets.code),
      );
      const input = {
        challengeId: yield* Schema.decodeUnknownEffect(ChallengeIdSchema)(challenge.id),
        deliveryId: yield* Schema.decodeUnknownEffect(DeliveryIdSchema)(delivery.id),
        recipient,
        code,
        expiresAt: yield* Schema.decodeUnknownEffect(IsoDateTimeSchema)(
          challenge.expires_at.toISOString(),
        ),
        locale: yield* Schema.decodeUnknownEffect(LocaleSchema)(saved.resolvedLocale),
        template: saved.template,
        remainingDeliveryMs: Math.max(
          0,
          challenge.expires_at.getTime() - time.getTime() - saved.sendTimeoutMs,
        ),
        ...(config.providers.get(saved.providerInstanceId)?.idempotency.supported === true
          ? { providerIdempotencyKey: delivery.id }
          : {}),
      };
      yield* countQuotas(limits, delivery.id, time);
      yield* sql`UPDATE otp_router.deliveries SET state = 'dispatching', reserved_at = ${time}, acceptance = 'unknown' WHERE id = ${delivery.id} AND state = 'pending'`;
      yield* sql`UPDATE otp_router.challenges SET send_count = send_count + 1, next_user_send_at = GREATEST(next_user_send_at,${new Date(time.getTime() + challenge.snapshot.resendCooldownSeconds * 1000)}) WHERE id = ${challenge.id}`;
      return {
        input,
        providerId: saved.providerInstanceId,
        gateMonotonicTime,
        minDeliveryWindowMs: saved.minDeliveryWindowMs,
        timeoutMs: Math.min(saved.sendTimeoutMs, challenge.expires_at.getTime() - time.getTime()),
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
      yield* recordOutcome(config, job.deliveryId, {
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
        deliveryId: job.deliveryId,
        providerInstanceId: reserved.providerId,
        outcome: "accepted",
        elapsedMilliseconds: performance.now() - started,
      });
      yield* recordAccepted(config, job.deliveryId, exit.value);
      return;
    }
    const outcome = failureOutcome(exit.cause, provider);
    yield* count("send", outcome.state);
    yield* logEvent({
      event: "provider_send",
      deliveryId: job.deliveryId,
      providerInstanceId: reserved.providerId,
      outcome: outcome.state,
      elapsedMilliseconds: performance.now() - started,
    });
    yield* recordOutcome(config, job.deliveryId, outcome);
    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
      return yield* Effect.failCause(exit.cause);
  });
