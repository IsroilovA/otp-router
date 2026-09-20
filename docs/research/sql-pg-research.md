# PostgreSQL and queue integration research

Completed 2026-09-19. This is historical integration evidence, not current version guidance. Outcome: select `@effect/sql-pg` and pg-boss for the initial implementation, using the latest stable compatible releases and rerunning these checks before adoption.

## Evidence

Reviewed the installed package sources and upstream documentation, then ran an isolated TypeScript probe against real PostgreSQL in a temporary Docker container. No provider accounts or production data were involved. Dependencies were installed outside the project; the project still contains planning documents only.

| Component | Tested version |
| --- | --- |
| Node.js | 24.18.0 |
| PostgreSQL | 17.11 |
| Effect | 3.22.2 |
| `@effect/sql-pg` | 0.53.0 |
| `@effect/sql` | 0.52.1 |
| `@effect/platform` | 0.97.2 |
| `@effect/experimental` | 0.61.1 |
| pg-boss | 12.33.2 |
| node-postgres `pg` | 8.23.0 |
| TypeScript compiler used for the probe | 7.0.2 |

The probe passed strict TypeScript checking and all nine checks below.

| Check | Observed result |
| --- | --- |
| Transaction identity and commit | The application insert and queue insert reported the same PostgreSQL transaction ID. A separate connection saw neither before commit and both after commit. |
| Typed failure | An Effect failure after enqueue rolled back the application row and job. |
| SQL failure | A unique-constraint violation rolled back both writes. |
| Concurrent transactions | Twelve concurrent transactions produced six independent commits and six independent rollbacks, with matching job counts. |
| Nested transaction | Rolling back an inner savepoint removed its row and job while preserving the outer transaction's row. |
| Interruption before commit | Cancellation after enqueue rolled back both writes. |
| Interruption inside the Promise adapter | A cancellation signal during the adapter call left no committed row, queued job, or idle transaction. |
| Delayed-job restart | A new queue instance recovered a delayed job from PostgreSQL and did not make it available before its due time. |
| Worker process crash | A child worker claimed a job and was killed with SIGKILL. After its lease expired, supervision made the same job available for retry. |

Cleanup also verified that disposing the Effect runtime released its PostgreSQL connections.

The crash check used a two-second test lease and an explicit supervision call. It establishes claim recovery, not production recovery latency or heartbeat settings.

## Why the integration works

Effect SQL's transaction wrapper supplies a transaction connection through the Effect context. SQL statements reuse that connection while the transaction is active. pg-boss accepts a per-operation database adapter whose `executeSql` method can run through that connection.

Capture the Effect runtime inside the transaction, construct a short-lived adapter there, and pass that adapter to the enqueue operation. Running its SQL through the captured runtime preserves the transaction connection. Use the untransformed SQL result so pg-boss receives the column names it expects.

The adapter must not escape or be cached. A runtime captured during startup does not contain the active transaction. Both approaches may type-check while giving the wrong transaction behavior, so the integration tests are required.

Sources: [Effect SQL transaction implementation](https://github.com/Effect-TS/effect/blob/v3/packages/sql/src/internal/client.ts), [PostgreSQL client implementation](https://github.com/Effect-TS/effect/blob/v3/packages/sql-pg/src/PgClient.ts), [pg-boss transaction adapter contract](https://pgboss.io/api/adapters).

## Selected implementation rules

1. `@effect/sql-pg` owns application SQL and transaction boundaries.
2. Use pg-boss through an Effect service. Queue worker callbacks execute router Effects through the service's existing runtime.
3. Insert a challenge, its initial attempt intent, and its queue job in one PostgreSQL transaction. A separate outbox relay is not required for this combination.
4. Construct the per-call pg-boss database adapter inside that transaction. Pass SQL parameters separately; do not interpolate user values into SQL strings.
5. Keep the enqueue bridge within a short cancellation-masked database section and await it completely before transaction cleanup. Bound database waits with statement and lock timeouts, and configure connection acquisition limits.
6. Never place a provider HTTP call inside that section or hold its database transaction open across external delivery.
7. Queue payloads contain attempt identifiers rather than plaintext codes or recipient details. Redact queue error outputs as well as application logs.
8. A retried job resumes persisted attempt state. It does not blindly repeat a provider request.
9. Treat the queue's concurrency controls as scheduling aids. Enforce challenge transitions and dispatch claims atomically in router-owned state.
10. Validate active challenge state and expiry immediately before dispatch, including after worker recovery.

The cancellation mask does not make remote delivery atomic. It protects the short local SQL bridge from being abandoned while its Promise still uses the transaction connection. Database failure or a lost commit response can still leave an uncertain result; API idempotency and reconciliation remain necessary.

## Runtime and database ownership

`@effect/sql-pg` uses node-postgres underneath. The probe used a router-owned pool and verified that disposing the runtime released its connections. In the standalone service, each router process owns and closes its database pools.

Use separate bounded pools for application SQL and queue management by default. Cross-pool transaction correctness comes from passing the transaction adapter for enqueue; it does not require every background queue operation to share the application's pool. Account for the combined connection budget.

Keep application migrations separate from pg-boss schema migrations. Select `PgMigrator` for router tables and the pg-boss migration tooling for its schema. The package exposes these facilities, but upgrade behavior has not been exercised by this probe. This experiment did not test migration timing; current [startup migration rules](../operations.md#data-ownership) supersede the original separate-command proposal.

## Compatibility and maintenance

The inspected package manifests declare MIT licensing for Effect, the tested Effect companion packages, pg-boss, and node-postgres. pg-boss 12.33.2 requires Node.js 22.12 or later; the tested Node.js 24 runtime meets that requirement. Recheck the selected versions and advisories when creating the implementation lockfile.

Effect's core and companion packages use different version lines. `@effect/sql-pg` has pre-1.0 versioning and peers on Effect SQL, Platform, and Experimental. Pin a compatible set and upgrade it with regression tests. These package dependencies do not themselves require Redis or LMDB services for the PostgreSQL integration. The probe ran with PostgreSQL alone.

Do not treat the tested PostgreSQL version as a claim of support for every version accepted by pg-boss. The project's PostgreSQL support range still needs definition and CI coverage.

## What this does not establish

- No real Telegram, WhatsApp, or Play Mobile request was sent.
- No test can turn database atomicity into exactly-once delivery by an external provider. A crash after provider acceptance still requires provider idempotency or an uncertain-outcome policy.
- The probe does not cover database failover, network partitions, lost commit responses, TLS termination, or connection-pool exhaustion.
- Production throughput, queue delay targets, heartbeat intervals, schema upgrades, and retention remain to be tested or specified.
- The cancellation test covers the adapter boundary; it is not a claim that every arbitrary Promise or provider SDK supports cancellation.

## Reproduction

The full probe and commands are retained in [the reproducible experiment](sql-pg-probe.md). It operates on a disposable database and creates its own research tables and queue schema. It is a compatibility experiment, not the production queue adapter or the final application's test suite.
