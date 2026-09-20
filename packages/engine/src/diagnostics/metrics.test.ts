import { expect, it } from "@effect/vitest";
import { Effect, Metric } from "effect";
import { count, duration, prometheus } from "./metrics.js";

it.effect("exports labeled counters and cumulative histogram buckets including overflow", () =>
  Effect.gen(function* () {
    yield* count("send", "accepted");
    yield* count("send", "accepted");
    yield* duration("provider", 10);
    yield* duration("provider", 60_001);
    yield* Metric.update(Metric.counter("private_adapter_requests"), 1);
    const output = yield* prometheus;
    expect(output).not.toContain("private_adapter_requests");
    expect(output).toContain("# TYPE otp_router_operations_total counter\n");
    expect(output).toContain("# TYPE otp_router_duration_milliseconds histogram\n");
    expect(output).toContain(
      'otp_router_operations_total{operation="send",outcome="accepted"} 2\n',
    );
    expect(output).toContain(
      'otp_router_duration_milliseconds_bucket{operation="provider",le="10"} 1\n',
    );
    expect(output).toContain(
      'otp_router_duration_milliseconds_bucket{operation="provider",le="+Inf"} 2\n',
    );
    expect(output).toContain('otp_router_duration_milliseconds_count{operation="provider"} 2\n');
    expect(output).toContain('otp_router_duration_milliseconds_sum{operation="provider"} 60011\n');
  }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
);
