import { Effect, Metric, MetricBoundaries, MetricState } from "effect";
import type { MetricPair } from "effect";

export const count = (
  event:
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
  const counter = Metric.tagged(
    Metric.tagged(Metric.counter("otp_router_operations_total"), "operation", event),
    "outcome",
    outcome,
  );
  return Metric.increment(counter);
};
export const duration = (
  operation: "database" | "selector" | "provider" | "queue",
  milliseconds: number,
) =>
  Metric.update(
    Metric.histogram(
      "otp_router_duration_milliseconds",
      MetricBoundaries.fromIterable([
        1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
      ]),
    ).pipe(Metric.tagged("operation", operation)),
    milliseconds,
  );
const render = (pair: MetricPair.MetricPair.Untyped): readonly string[] => {
  const name = pair.metricKey.name;
  if (!name.startsWith("otp_router_")) return [];
  const labels = pair.metricKey.tags.map((tag) => `${tag.key}=${JSON.stringify(tag.value)}`);
  const state = pair.metricState;
  if (MetricState.isCounterState(state)) return [`${name}{${labels.join(",")}} ${state.count}`];
  if (MetricState.isHistogramState(state))
    return [
      ...state.buckets.map(
        ([limit, value]) =>
          `${name}_bucket{${[...labels, `le="${Number.isFinite(limit) ? limit : "+Inf"}"`].join(",")}} ${value}`,
      ),
      `${name}_count{${labels.join(",")}} ${state.count}`,
      `${name}_sum{${labels.join(",")}} ${state.sum}`,
    ];
  return [];
};
export const prometheus = Metric.snapshot.pipe(
  Effect.map((pairs) => `${pairs.flatMap(render).join("\n")}\n`),
);
