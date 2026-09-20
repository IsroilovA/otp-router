# Local capacity benchmark

This record describes one implementation benchmark. It is evidence for this checkout on the
reference machine, not a service-level objective or a claim about provider throughput. The provider
is a deterministic local fake with a five-millisecond delay. It records delivery IDs and invocation
times in a mode-0600 file; it does not record recipients or codes.

## Reproduce

Docker must be running. From the repository root, run:

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run --config vitest.benchmark.config.ts --reporter=verbose
```

The cleanup recovery phase can also be run independently:

```sh
OTP_BENCHMARK_RECOVERY_ONLY=1 pnpm exec vitest run --config vitest.benchmark.config.ts --reporter=verbose
```

Record the measured source-content digest immediately before a run with:

```sh
find src -type f -print0 | LC_ALL=C sort -z | xargs -0 cat | shasum -a 256
```

The benchmark configuration includes only `tests/capacity.benchmark.ts`, so the normal test suite
does not run the 15-minute workload. The test builds the service, starts a disposable
`postgres:17-alpine` container on local Docker TCP, starts separate API and worker processes, and
removes its processes, container, generated configuration, and provider sink during cleanup.
Steady and ramp phase summaries are emitted as soon as each phase completes, so a later recovery
failure cannot discard valid measurements.

The steady phase targets five HTTP creates per second for 900,000 milliseconds with unique synthetic
Uzbekistan E.164 recipients. The concurrency ramp issues 200 creates at each concurrency level 1, 4,
8, 16, and 32. The configured deployment and provider caps are 1,000,000 per 15 minutes and per 24
hours; recipient limits remain 5 creates and 10 sends per 15 minutes. Unique recipients ensure the
reference workload remains below those per-recipient limits. Separate correctness tests cover quota
rejection.

The recovery phase first accumulates a 50-job backlog while the worker is stopped and measures the
time from the first backlog submission until the delivery backlog returns to zero after restart. It
then blocks one fake-provider call after its durable dispatch reservation, kills the worker, ages only
the pg-boss lease timestamp, and invokes pg-boss's public supervisor. The test checks the real
`active` to `retry` to `completed` job lifecycle, the delivery's `uncertain` recovery state, and
exactly one fake-provider invocation.

## Reference environment and measured source

The final-source steady and cleanup recovery observations used SHA-256
`08fe1dbec422b002046c41d6f52b68435a7b98f02cb2a6ab8afe6baea0f25c94`. This is the digest of the
concatenated contents of every regular file under `src`, in bytewise sorted path order, immediately
before the run. The same digest was confirmed after the bounded recovery run. The Git commit was
`188ad0f4129ef14c9409588cead46083befc7ab7` with uncommitted implementation changes on 2026-09-20.

The runs used macOS Darwin 25.6.0 on an Apple M4 Pro with 12 logical CPUs and 24 GiB RAM, Node.js
26.8.2, Docker Engine 29.7.2, PostgreSQL 17.11, pnpm 12.5.1, Effect 3.22.2, `@effect/sql-pg`
0.53.0, and pg-boss 12.33.2. PostgreSQL used its default 100-connection limit in a local container.
Traffic used loopback HTTP and Docker's local TCP port mapping; it did not traverse an external
network. The machine also performed occasional repository validation during the runs.

The API and worker each configure a 10-connection application pool and a 6-connection pg-boss pool.
Worker concurrency is 8, delivery polling is 500 milliseconds, job expiration is 90 seconds, and
transport retries are disabled. PostgreSQL and the service processes shared the reference machine;
the container had no explicit CPU or memory limit.

## Results

### Final-source observations

The final-source steady phase completed 4,501 HTTP create attempts in 900 seconds at the configured
five operations per second. A later cleanup-recovery assertion in the benchmark harness was too
strict: it required zero newly overdue challenges at an instant even though five challenges became
due each second between cleanup sweeps. The assertion failed after the steady and ramp phases, before
their in-memory latency and status summaries were emitted. Those detailed final-source HTTP, queue,
ramp, and resource metrics are unavailable and are not reconstructed from the earlier run.

Read-only samples during that steady phase showed cleanup remained bounded after challenges began to
expire:

| Observation | Active overdue | Oldest overdue | Total expired |
| --- | ---: | ---: | ---: |
| First sample | 249 | 49.752 s | 151 |
| Before next sweep | 287 | 57.388 s | 454 |
| After next sweep | 34 | 6.654 s | not sampled |

The corrected bound is no active challenge more than 90 seconds overdue. The harness now samples and
asserts that bound during the steady phase.

A separate bounded run against the same source digest captured the exact 250 UUIDs returned by HTTP,
confirmed the database cohort matched all 250 IDs, stopped the worker, and moved only that cohort two
minutes past expiry. After worker restart, all 250 reached `expired` in 16,269.15 ms. Zero cohort
members remained active and zero cohort secret rows remained. The bounded run passed in 35.57
seconds.

Before the cleanup fix, the corresponding steady run reached 523 overdue active challenges with the
oldest 104.489 seconds overdue around minute 12, then 1,021 with the oldest 204.099 seconds overdue
around minute 14. That evidence exposed the fixed 100-row-per-minute cleanup limit and prompted the
draining implementation now measured above.

### Initial full baseline

An earlier implementation baseline completed all benchmark phases before the final quota-query and
cleanup changes. Its source-content digest was not recorded, so these values are retained as
historical capacity context rather than final-source measurements. The steady phase completed 4,501
creates in 900 seconds. It sustained 5.00 operations per second with no HTTP errors. HTTP latency was
47.50 ms p50, 69.09 ms p95, and 89.99 ms p99. Queue delay was 318 ms p50, 538 ms p95, and 580 ms p99.

| Concurrent clients | Operations | Operations/second | p50 | p95 | p99 | HTTP errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 200 | 24.92 | 28.51 ms | 168.37 ms | 176.28 ms | 0 |
| 4 | 200 | 27.56 | 104.53 ms | 253.85 ms | 258.78 ms | 0 |
| 8 | 200 | 26.22 | 354.53 ms | 371.13 ms | 467.02 ms | 0 |
| 16 | 200 | 19.71 | 725.28 ms | 1,306.41 ms | 1,540.74 ms | 0 |
| 32 | 200 | 21.07 | 1,525.15 ms | 1,751.67 ms | 1,791.97 ms | 0 |

The baseline's highest sampled ramp throughput was 27.56 operations per second at concurrency 4.
Throughput stopped increasing at concurrency 8 and latency rose sharply, so concurrency 4 to 8 was
the observed saturation region for that implementation snapshot and local setup. The short ramp does
not establish that 27.56 operations per second is sustainable.

The baseline 50-job recovery observation took 4,940.31 ms from the first backlog submission until the
backlog returned to its pre-interruption level. Crash recovery took 5,501.04 ms from
replacement-worker startup until the interrupted delivery became uncertain. Across 5,552 committed
deliveries, the fake provider recorded 5,552 invocations and the database recorded 5,552 terminal
delivery outcomes. There were no duplicate external sends, HTTP errors, lost eligible deliveries, or
per-recipient quota violations.

Baseline peak API RSS was 399.08 MiB and peak worker RSS was 402.59 MiB. Peak sampled CPU was 58.7%
for the API and 89.5% for the worker. PostgreSQL peaked at 26 connections, below the combined
32-connection service and queue pool limit; the sampled value includes one additional short-lived
measurement connection. The database's configured maximum was 100 connections.

## Interpretation and limits

The HTTP timing is measured at the local client around each complete create request. Queue delay is
the PostgreSQL interval from delivery `due_at` to the worker's durable `reserved_at`. Peak RSS and CPU
come from `ps`; the connection peak comes from `pg_stat_activity` and includes the sampling
connection. Sampling adds a small amount of local process and database load.

The current implementation does not expose pool acquisition wait time, so the runs cannot report
that metric. PostgreSQL memory sampling was added to the harness after the baseline, but the
final-source full report did not survive the later harness assertion; no PostgreSQL peak-memory value
is claimed. The benchmark covers worker loss and lease supervision; it does not measure a database
restart, remote database latency, multi-host workers, callback throughput, verification throughput,
or live-provider behavior. Live provider sends require credentials and explicit authorization and
were not performed.
