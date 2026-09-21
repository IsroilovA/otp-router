import { Effect, Metric } from "effect";
import { PrometheusMetrics } from "effect/unstable/observability";

export const count = (
  event:
    | "external_delivery"
    | "create"
    | "verify"
    | "cancel"
    | "deliver"
    | "status"
    | "send"
    | "recovery"
    | "callback"
    | "suppressed",
  outcome: string,
) => {
  return Metric.update(
    Metric.counter("otp_router_operations_total", {
      attributes: { operation: event, outcome },
    }),
    1,
  );
};
export const duration = (
  operation: "database" | "selector" | "provider" | "queue",
  milliseconds: number,
) =>
  Metric.update(
    Metric.histogram("otp_router_duration_milliseconds", {
      boundaries: [
        1,
        5,
        10,
        25,
        50,
        100,
        250,
        500,
        1000,
        2500,
        5000,
        10000,
        30000,
        60000,
        Infinity,
      ],
      attributes: { operation },
    }),
    milliseconds,
  );
export const prometheus = Effect.gen(function* () {
  const registry = yield* Metric.MetricRegistry;
  const exposed = new Map(
    [...registry].filter(([, metric]) => metric.id.startsWith("otp_router_")),
  );
  return yield* PrometheusMetrics.format().pipe(
    Effect.provideService(Metric.MetricRegistry, exposed),
  );
});
