# Implementation evidence

This checklist tracks the 109 acceptance scenarios in [the product specification](specifications.md#acceptance-scenarios). `Passing` means the named test passed in the focused run recorded below. `Inspected` records a direct source or contract inspection. `Partial` records useful boundary evidence that does not prove the complete scenario. `Pending` means that no test or inspection currently proves the complete scenario. A passing test may cover only the stated part of a broader scenario.

Evidence must use real PostgreSQL for transactions, quotas, locks, migrations, recovery, and concurrent processes. Use the deterministic fake provider for network boundaries. Do not use real provider sends without an explicitly designated recipient and authorization. Provider-specific production claims also require the evidence listed in [provider research](provider-research.md#remaining-provider-evidence).

| ID | Evidence to record | Status |
| --- | --- | --- |
| S001 | `tests/integration.test.ts` "runs HTTP create, queued dispatch, and verification end to end"; `tests/process.test.ts` "runs HTTP create through a queued worker send and verifies with the sink code" | Passing |
| S002 | `tests/integration.test.ts` "falls back after definitive rejection but preserves an uncertain outcome" | Passing |
| S003 | `tests/integration.test.ts` "reconciles a delivered callback that arrives before the send response" and "deduplicates delivered callbacks without suppressing a later explicit resend" | Passing |
| S004 | Inspection: `src/delivery/eligibility.ts` `eligibleProviders` filters the persisted route; `src/delivery/dispatch.ts` dispatches only the selected provider | Inspected |
| S005 | Inspection: `src/challenges/snapshot.ts` preserves provider order and `src/delivery/schedule.ts` uses route positions | Inspected |
| S006 | `tests/integration.test.ts` "preserves verification but blocks every delivery action after invalid recipient" | Passing |
| S007 | `tests/integration.test.ts` "reuses the code for explicit resend and erases terminal secrets" | Passing |
| S008 | Inspection: `src/delivery/actions.ts` `requestDelivery` handles `next` and `src/delivery/schedule.ts` advances route position | Inspected |
| S009 | `tests/integration.test.ts` "replays a wrong guess without consuming another guess and locks at the limit"; "blocks a correct code at the recipient guess cap without extending usage" | Passing |
| S010 | `tests/integration.test.ts` "commits terminal expiry when an explicit delivery request finds an expired challenge" and cancellation expiry coverage | Passing |
| S011 | `tests/integration.test.ts` "allows one winner when correct verification races" | Passing |
| S012 | `tests/process.test.ts` discards the first create response before reading its challenge ID, then concurrent retries across independent API processes recover the one committed challenge and delivery. | Passing |
| S013 | `tests/integration.test.ts` "falls back after definitive rejection but preserves an uncertain outcome"; `tests/process.test.ts` "recovers a killed in-flight worker as uncertain without a second provider send" | Passing |
| S014 | `tests/integration.test.ts` "falls through after a definitive provider configuration rejection" | Passing |
| S015 | `tests/integration.test.ts` "falls back on throttling but restricts later explicit use until retry time" | Passing |
| S016 | Process tests kill the worker before reservation commit, after dispatch commit before external transmission, during a send, and after acceptance before outcome persistence. Recovery retains reservations and never repeats a crossed dispatch gate. | Passing |
| S017 | `tests/integration.test.ts` "deduplicates delivered callbacks without suppressing a later explicit resend"; "does not let a stale failure callback advance past a newer next action" | Passing |
| S018 | `tests/integration.test.ts` "does not send fallback when correct verification races a definitive outcome" | Passing |
| S019 | `tests/integration.test.ts` "atomically enforces recipient create quotas across concurrent challenges" | Passing |
| S020 | Inspection: `src/challenges/verify.ts` checks purpose and context before code comparison | Inspected |
| S021 | The separate `examples/custom-adapter` fixture compiles against public exports and runs its selector and custom-channel provider in a built image. Core routing treats configured channels uniformly. | Passing |
| S022 | `tests/integration.test.ts` "skips an emergency-disabled provider without reserving a send" preserves verification and dispatches the saved later route. Compatible-setting checks and the drain procedure remain explicit. | Passing |
| S023 | Inspection: client/public-login limits belong to the adopting backend under `docs/security.md`; router recipient and deployment quota tests are named in S019/S046 | Inspected |
| S024 | Inspection: `src/delivery/dispatch.ts` records accepted state separately and `src/delivery/outcomes.ts` leaves missing callbacks unchanged | Inspected |
| S025 | Maintenance tests expire overdue challenges, erase secrets, retain live quota usage, and drain 205 expirations plus 1,005 old quota events across bounded transactions in one sweep. | Passing |
| S026 | The quota-lock tests make create, verify, and dispatch fail closed at the database deadline with no extra writes, reservations, or provider calls; the same operation keys succeed after quota access returns. The process suite separately tests a paused database. | Passing |
| S027 | `src/http/transport.test.ts` authenticates before any Router call; provider tests authenticate raw callback bytes. Application backends own end-user authorization under D042. | Passing |
| S028 | Inspection: `ProviderDefinition` declares constraints and optional callbacks; `validatePolicyProviders` rejects incompatible code/lifetime settings. V1 has no policy requiring a deferred provider capability. | Inspected |
| S029 | Same-channel selection tests cover ordered eligibility and quotas. `requestDelivery` does not prohibit an uncertain delivery state; all explicit actions pass the same expiry, cooldown, and budget checks. | Inspected |
| S030 | Inspection: `src/delivery/eligibility.ts` `resolveChoice` rejects unavailable providers before scheduling | Inspected |
| S031 | `tests/integration.test.ts` "selects an available same-channel provider while preserving explicit provider quotas" | Passing |
| S032 | Inspection: `createChallenge` persists the validated selector route in the challenge snapshot; dispatch and later actions use that snapshot without running the selector again. | Inspected |
| S033 | Inspection: `logEvent` accepts normalized fields and never receives requests or causes; bounded metric labels come from fixed operation/outcome values. Process and image smoke tests assert API-key and phone redaction. | Inspected |
| S034 | `tests/integration.test.ts` "persists per-provider locale templates and reuses them without rerunning selection" | Passing |
| S035 | `tests/integration.test.ts` "falls forward from an initially selected middle provider without route wraparound" starts with the selected middle instance and invokes only its later fallback. | Passing |
| S036 | Inspection: `src/delivery/eligibility.ts` `resolveChoice` checks `manualSelectionEnabled` | Inspected |
| S037 | `tests/integration.test.ts` "keeps verification available after the send budget is exhausted" | Passing |
| S038 | `tests/integration.test.ts` "cancels once, replays cancellation, and suppresses queued delivery" | Passing |
| S039 | Inspection: `src/delivery/outcomes.ts` merges dispatched outcomes against terminal challenge state without reopening it | Inspected |
| S040 | `tests/integration.test.ts` "samples database time after a blocked row lock before deciding expiry" | Passing |
| S041 | `tests/maintenance.test.ts` "requires invalidation and an elapsed quota window before adopting a recipient key" | Passing |
| S042 | Inspection: `src/delivery/dispatch.ts` samples database time at the gate, extends cooldown at reservation, and never changes `expires_at` | Inspected |
| S043 | `tests/integration.test.ts` "deduplicates delivered callbacks without suppressing a later explicit resend" | Passing |
| S044 | `tests/integration.test.ts` "replays successful verification after erasure without comparing a changed code" | Passing |
| S045 | Inspection: `src/delivery/eligibility.ts` `eligibleProviders` checks `minDeliveryWindowMs` before `dispatchGate` reserves quota | Inspected |
| S046 | `tests/integration.test.ts` "atomically reserves the last deployment send across different recipients" | Passing |
| S047 | Inspection: `src/delivery/dispatch.ts` maps unknown acceptance to `uncertain`; explicit action creates a new record in `src/delivery/actions.ts` | Inspected |
| S048 | `tests/integration.test.ts` "deduplicates delivered callbacks without suppressing a later explicit resend" | Passing |
| S049 | `tests/integration.test.ts` "deduplicates delivered callbacks without suppressing a later explicit resend" | Passing |
| S050 | `tests/integration.test.ts` "does not let a stale failure callback advance past a newer next action" | Passing |
| S051 | `tests/integration.test.ts` "does not retry an uncertain idempotency-capable provider on duplicate dispatch" | Passing |
| S052 | `src/config/config.test.ts` "rejects unsupported fallback/retry configuration, invalid bounds and reused secret keys" | Passing |
| S053 | Process tests create queued work before starting a worker, then consume it normally. The killed-worker and dispatch-gate tests recover crossed gates as uncertain without another invocation. | Passing |
| S054 | The multi-provider locale test gives both resolvers `[uz,ru,en]`, persists different ru/en templates, and observes their saved values. | Passing |
| S055 | The locale test deduplicates `[uz,ru,en,ru,en]` into `[uz,ru,en]`; `prepare` supplies the configured default when locale is omitted. | Passing |
| S056 | The locale test dispatches initial send and resend with the same saved template and locale; selector/resolver call counts remain unchanged. | Passing |
| S057 | Inspection: built-in `make` Layers only validate local settings; `--check-config` with placeholder credentials succeeds without contacting providers. Provider network work occurs only in `send`. | Inspected |
| S058 | `tests/integration.test.ts` "rejects selector timeout, rejection, expansion, and an excluded manual choice" | Passing |
| S059 | Resend tests preserve original expiry and guess count. Inspection: delivery actions never write expiry; Telegram/Play TTL use the remaining budget and example messages contain no relative validity claim. | Inspected |
| S060 | `tests/process.test.ts` "recovers a killed in-flight worker as uncertain without a second provider send"; `tests/queue-transaction.test.ts` delayed-work restart test | Passing |
| S061 | `tests/integration.test.ts` "rejects selector timeout, rejection, expansion, and an excluded manual choice" | Passing |
| S062 | `tests/integration.test.ts` "rejects selector timeout, rejection, expansion, and an excluded manual choice" | Passing |
| S063 | `tests/integration.test.ts` "rejects selector timeout, rejection, expansion, and an excluded manual choice" | Passing |
| S064 | Concurrent create tests prove one commit and one saved route. Inspection: selectors run before the operation lock/recheck, and every later action reads the persisted snapshot. | Inspected |
| S065 | Selector timeout tests leave no challenge or job; `Settings.selectorTimeoutMs` defaults to 2,000 and Effect timeout bounds the full selector Effect. Late results cannot reach the commit path. | Inspected |
| S066 | `src/http/transport.test.ts` "rejects duplicate, unknown, compressed, missing-key, and streamed oversized input" | Passing |
| S067 | `tests/integration.test.ts` "replays a wrong guess without consuming another guess and locks at the limit" | Passing |
| S068 | `tests/integration.test.ts` "cancels once, replays cancellation, and suppresses queued delivery" | Passing |
| S069 | `tests/process.test.ts` "bounds shutdown with an unfinished HTTP body and an in-flight provider call" verifies create returns while provider work remains in flight | Passing |
| S070 | `tests/queue-transaction.test.ts` "commits application and queue writes together, invisible before commit"; rollback and interruption tests | Passing |
| S071 | `tests/integration.test.ts` "runs HTTP create, queued dispatch, and verification end to end" | Passing |
| S072 | Inspection: `src/challenges/verify.ts` checks purpose/context before loading and comparing the code | Inspected |
| S073 | `tests/integration.test.ts` "replays successful verification after erasure without comparing a changed code" | Passing |
| S074 | HTTP tests protect authenticated status wiring and durable webhook acknowledgement; PostgreSQL tests ingest callbacks and observe the resulting saved delivery state. No outbound application-notification operation exists. | Passing |
| S075 | `tests/process.test.ts` "runs HTTP create through a queued worker send and verifies with the sink code" | Passing |
| S076 | `tests/integration.test.ts` "preserves idempotent replay while application API keys rotate" | Passing |
| S077 | API-key rotation integration constructs overlap and removed-key HTTP layers, preserves replay, and rejects the removed key before any Router call. Callback authentication uses its separate adapter contract. | Passing |
| S078 | `tests/integration.test.ts` "serializes concurrent create replay and rejects changed input" | Passing |
| S079 | `tests/integration.test.ts` "replays successful verification after erasure without comparing a changed code" plus active changed-code conflict assertions | Passing |
| S080 | `tests/integration.test.ts` "serializes concurrent create replay and rejects changed input" | Passing |
| S081 | `tests/integration.test.ts` "maps an operation advisory-lock timeout to request_in_progress" | Passing |
| S082 | `tests/integration.test.ts` "does not complete a cooldown-rejected operation key and accepts its later retry" and quota equivalent | Passing |
| S083 | `tests/integration.test.ts` "replays a wrong guess without consuming another guess and locks at the limit" | Passing |
| S084 | HTTP validation/authentication tests assert no Router call; queue transaction tests assert rollback removes both domain writes and jobs. Completed operation results are written in the same transaction as mutations. | Passing |
| S085 | `tests/maintenance.test.ts` retention regression removes expired results only after terminal work settles, then reuses the key to create a distinct active challenge. | Passing |
| S086 | The maintenance retention test replays a result older than 24 hours while active and preserves terminal history/results while a delivery is dispatching. | Passing |
| S087 | Inspection: accepted outcomes remain unconfirmed until authenticated evidence arrives; completed queue work schedules no timer or provider lookup. Process tests observe accepted status and verify without receipts. | Inspected |
| S088 | Inspection: `src/challenges/service.ts` status reads stored rows and `src/worker/run.ts` dispatch recovery does not call provider status APIs | Inspected |
| S089 | `tests/process.test.ts` "supports config/schema checks and separate API and worker health"; `tests/queue-transaction.test.ts` empty-database migration test | Passing |
| S090 | `tests/queue-transaction.test.ts` fresh migration rollback and concurrent-start tests | Passing |
| S091 | `src/config/config.test.ts` "validates adapter defaults even when a valid timeout override is supplied" | Passing |
| S092 | `tests/integration.test.ts` "enforces an instance timeout and keeps a never-completing send uncertain" | Passing |
| S093 | `tests/integration.test.ts` "enforces an instance timeout and keeps a never-completing send uncertain" | Passing |
| S094 | `tests/process.test.ts` "bounds shutdown with an unfinished HTTP body and an in-flight provider call" | Passing |
| S095 | `tests/process.test.ts` "recovers a killed in-flight worker as uncertain without a second provider send" and "bounds shutdown with an unfinished HTTP body and an in-flight provider call" | Passing |
| S096 | `tests/process.test.ts` pauses its disposable PostgreSQL container: liveness returns 200, readiness returns 503, and readiness recovers after unpause. Startup rejects unsupported schemas. | Passing |
| S097 | Inspection: readiness queries only PostgreSQL and worker state. Built-in Layer construction and config checks perform no provider health or send request. | Inspected |
| S098 | `tests/process.test.ts` "supports config/schema checks and separate API and worker health" | Passing |
| S099 | `tests/process.test.ts` "supports config/schema checks and separate API and worker health" | Passing |
| S100 | Inspection: `main.ts` loads one entry at startup and installs the resulting configuration in a Layer. No watcher or reload path exists; operations documents draining incompatible changes. | Inspected |
| S101 | `src/http/transport.test.ts` "wires status, verification, delivery, and cancellation to their Router operations"; OpenAPI test | Passing |
| S102 | `src/http/transport.test.ts` "sets replay and retry headers from Router outcomes" | Passing |
| S103 | `src/http/transport.test.ts` "authenticates before challenge access and uses server request IDs"; error envelope assertions | Passing |
| S104 | An injected Router defect through the HTTP handler returns 500/internal_error with a request ID, leaks none of the supplied private error text, and creates no database state. | Passing |
| S105 | Inspection: `src/challenges/create.ts` `normalizePhone` delegates to libphonenumber-js and rejects missing international context | Inspected |
| S106 | Inspection: `src/challenges/create.ts` `normalizePhone` runs before recipient token and route selection | Inspected |
| S107 | `src/http/transport.test.ts` "passes a strict validated create request to Router and returns its committed result" | Passing |
| S108 | The operations contract documents drain, stop, startup migration, and restart. This first schema has no prior released version to upgrade; representative production-data migration timings remain an operator release gate. | Inspected |
| S109 | The operations contract requires explicit cross-version compatibility before rolling upgrades. No such compatibility is claimed for this first private implementation. | Inspected |

## Observed test run

The current targeted commands, run without the benchmark suite, are:

```sh
pnpm exec vitest run tests/integration.test.ts
pnpm exec vitest run tests/maintenance.test.ts
pnpm exec vitest run tests/process.test.ts
pnpm exec vitest run tests/queue-transaction.test.ts src/http/transport.test.ts src/challenges/crypto.test.ts src/providers/providers.test.ts
```

The latest reported targeted results include 42 of 42 integration tests, 7 of 7 maintenance tests, and 9 of 9 process tests passing. The fault-boundary suite has 2 passing tests for pool exhaustion and connection termination during atomic queue insertion. Queue transaction coverage has 8 passing tests, alongside the provider, HTTP, crypto, configuration, and queue lifecycle suites. S044's terminal replay rule is covered: after code material is erased, a matching verification operation key replays the stored result without comparing a changed syntactically valid code. The final `pnpm test` run passed all 90 tests in 10 files in 44.29 seconds. Inspected rows remain distinct from automated coverage.

## Release evidence still required

The automated suites and image/package smoke checks establish local HTTP flows, real PostgreSQL transactions and concurrency, callback normalization, retention, key lifecycle, readiness, bounded shutdown, and worker recovery. The [benchmark](benchmark.md) records a 15-minute fake-provider run and a concurrency/recovery ramp.

Remaining evidence concerns live provider credentials, approved templates, actual receipt and callback behavior, production-data migration timing, database failover and network partitions around commit. Actual process-kill tests cover an uncommitted reservation, a committed dispatch before external transmission, an in-flight provider call, and an accepted response blocked before outcome persistence. The benchmark does not separately measure pool acquisition wait. Its detailed performance baseline precedes the final cleanup fix; final-source latency and resource samples were lost after a later benchmark assertion failed. The corrected exact-cohort cleanup recovery passed separately. The service is a working private v1 implementation; it is not certified for production accounts by these local tests. No real provider sends were made.

A terminated PostgreSQL backend can raise a defect during transaction cleanup. The fault test asserts rollback and safe retry through the complete failed Effect exit; it does not claim a typed domain error at that boundary. HTTP defect tests separately verify a sanitized 500 response. Pool exhaustion returns the typed `temporarily_unavailable` error after the five-second acquisition deadline.

## Dependency note

The current npm registry metadata reports `libphonenumber-js` version `1.13.13`, licensed MIT, with the upstream repository at <https://gitlab.com/catamphetamine/libphonenumber-js>. This was a read-only `npm view libphonenumber-js version license repository.url --json` lookup on 2026-09-20. No dependency was added by this document.
