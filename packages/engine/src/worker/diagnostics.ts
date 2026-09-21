import type { ProviderSendError } from "../providers/contract.js";
import { Cause, Effect } from "effect";
import type { CryptoError } from "../crypto.js";
import type { CorrelationConflict } from "../delivery/callbacks.js";
import { failureCategory, type InfrastructureError } from "../diagnostics/operation.js";
import { logEvent, type FailureCategory } from "../diagnostics/log.js";
import { count } from "../diagnostics/metrics.js";
import type { DomainError } from "../errors.js";
import { QueueOperationError } from "../queue/jobs.js";

type JobError =
  | InfrastructureError
  | DomainError
  | CryptoError
  | CorrelationConflict
  | ProviderSendError
  | Cause.TimeoutError;
const category = (cause: Cause.Cause<JobError>): FailureCategory => {
  if (Cause.hasDies(cause)) return "defect";
  if (Cause.hasInterrupts(cause)) return "interrupted";
  const error = Cause.findErrorOption(cause);
  if (error._tag === "None") return "defect";
  switch (error.value._tag) {
    case "CryptoError":
      return "crypto_failure";
    case "CorrelationConflict":
      return "correlation_conflict";
    case "InvalidRecipient":
    case "RecipientUnavailable":
    case "ProviderThrottled":
    case "ProviderConfigurationRejected":
    case "TemporaryProviderFailure":
    case "UnknownProviderOutcome":
      return "provider_failure";
    case "TimeoutError":
      return "timeout";
    case "DomainError":
    case "NoSuchElementError":
    case "QueueOperationError":
    case "SchemaError":
    case "SqlError":
      return failureCategory(error.value) ?? "domain_rejection";
  }
};

export const observeJob = <A, E extends JobError, R>(
  effect: Effect.Effect<A, E, R>,
  job: { readonly queue: string; readonly jobId: string },
) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const failure = category(cause);
        yield* logEvent({
          event: "worker_failure",
          ...job,
          outcome: "failed",
          failureCategory: failure,
        });
        yield* count("worker", failure);
        // pg-boss persists rejected errors. Redact their contents while preserving the cause channel.
        if (Cause.hasDies(cause)) return yield* Effect.die(new Error("Worker defect"));
        if (Cause.hasInterrupts(cause)) return yield* Effect.interrupt;
        return yield* Effect.fail(new QueueOperationError());
      }),
    ),
  );
