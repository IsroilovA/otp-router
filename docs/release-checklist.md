# Private release acceptance

Status: required evidence; application tests have not run.

## Correctness gates

Trace every [acceptance scenario](specifications.md#acceptance-scenarios) to a passing test or documentation/configuration inspection before a production-ready private release. Earlier development builds must identify incomplete capabilities.

| Suite | Required evidence |
| --- | --- |
| Type and boundary checks | Strict type checking, exhaustive error handling, HTTP/OpenAPI agreement, runtime schemas at external boundaries, request-size enforcement, leading-zero codes, unknown fields, and invalid configuration. |
| Atomic operations | Real PostgreSQL with at least two independent processes; simultaneous create/replay, correct verification, last allowed wrong guess, cancellation, and send reservation. Assert rows, counters, responses, and queue jobs. |
| Dispatch failure boundaries | Terminate a worker before reservation, after dispatch commit but before the network call, during transport, after provider response, and before outcome commit. Count external calls with a durable fake provider. No dispatched delivery invokes send twice; ambiguity retains its reservation and never advances automatically. |
| Routing | Definitive rejection advances once; uncertainty never advances or retries; explicit resend and selection remain available when eligible; stale failures and duplicate delivered receipts cannot change a newer action. |
| Callbacks | Invalid signature, altered raw bytes, duplicate/out-of-order events, batch failures, callback-before-response, unknown correlation, terminal state, and expired history. Acknowledgement requires durable ingestion; no report verifies a challenge. |
| Secrets and retention | Terminal erasure covers code ciphertext, verifier, and code fingerprints. Wrong binding spends no guess. API-key rotation preserves replay; cryptographic key overlap preserves decoding. Quotas outlive deleted history. Logs, metrics, persisted errors, and snapshots contain no forbidden data. |
| Recovery and deployment | Automatic initial migration and upgrade before readiness, concurrent starts, interrupted/failed migrations, unsupported schema rejection, required database permissions, shutdown deadlines, database loss, worker lease recovery, restore invalidation, and recipient-key incident procedure. |
| Extensions and packaging | Separate custom adapter/selector fixture compiles against exported types and runs from its built image. Combined and separate process roles share correct state. No public registry publishing. |

Use barriers and controlled fake-provider responses for deterministic race tests. Include database disconnection around commit and pool exhaustion. Assert that an unknown commit is resolved through idempotency or delivery state before another side effect. Pure deadline tests may use controlled time; PostgreSQL concurrency tests must use actual database time and locks.

## Provider gates

Resolve the [provider evidence gaps](provider-research.md#remaining-provider-evidence). Record the selected API version, request/response fixture provenance, configured timeout, TTL calculation, known rejection allowlist, and live smoke-test result for each enabled built-in. Redact fixture secrets, OTPs, recipients, and account identifiers. Live tests need configured accounts and a designated recipient.

A live smoke test covers create, actual receipt, explicit resend before expiry, and successful verification. Where authenticated callbacks are supported, confirm correlation and signature processing with the real provider. Test failure behavior with deterministic transports; do not spend money manufacturing every remote failure. Unsupported receipt authentication keeps that callback capability disabled. Unknown provider errors must remain uncertain.

## Benchmark procedure

Choose and record one reproducible reference environment during implementation: CPU, memory, operating system, database version and placement, connection limits, worker concurrency, queue settings, package versions, and network conditions. Use deterministic fake providers for capacity measurements and separate live-provider latency observations. Do not describe simulated provider throughput as a real provider's capacity.

Run steady load, a concurrency ramp, and a recovery run after a worker/database interruption. Each steady phase lasts at least fifteen minutes, covering a recipient quota window. Exercise the twenty-four-hour accounting window with controlled database fixtures in a separate correctness test. Use synthetic recipients and policies whose limits permit the intended workload, plus explicit tests that exceed the limits.

Report achieved operations per second, p50/p95/p99 HTTP latency, queue delay, pool wait, error counts, recovery time, and peak memory/connections. At the declared reference load, no committed eligible job may be silently lost, no quota may be exceeded, and no delivery may invoke send twice. Queue backlog must return to its pre-interruption level within the documented recovery observation period. Bound resource usage by configured pool/concurrency limits. Publish the sustainable measured load and the saturation point, without inventing a universal throughput or provider-delivery SLA.

## Release evidence record

Keep one record per private release containing the artifact versions/digests, locked dependencies, supported Node.js/PostgreSQL ranges, schema/job/snapshot/provider-contract compatibility, test report, benchmark report, provider evidence, migration sequence, and known limitations. Do not label a capability supported while its required integration evidence is absent. Distribution remains private.
