# Reproducible SQL and queue experiment

This is the isolated compatibility experiment described in [SQL and queue research](sql-pg-research.md). It preserves the historical environment exactly; it is not current dependency guidance or production code. Use a fresh disposable database because the script creates a research table and queue schema.

The experiment uses real PostgreSQL and a child process that it kills after a job claim. It never calls a delivery provider.

## Setup

To reproduce the original result exactly, use Node.js 24.18.0 and PostgreSQL 17.11. The PostgreSQL image had digest `sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995`. For implementation, select the latest stable compatible releases and rerun this probe before adoption.

Create a temporary directory and save the TypeScript block below as `probe.mts` there. Then install the pinned direct packages:

```sh
npm install --ignore-scripts --no-audit --no-fund --save-exact effect@3.22.2 @effect/sql-pg@0.53.0 @effect/sql@0.52.1 @effect/platform@0.97.2 @effect/experimental@0.61.1 pg-boss@12.33.2 pg@8.23.0 typescript@7.0.2 @types/node@26.6.2 @types/pg@8.23.1
```

These commands pin the listed packages. Other transitive dependencies may resolve differently on a later run; the tested version table is an evidence snapshot, not a complete production lockfile.

Start a temporary database on an automatically assigned localhost port:

```sh
docker run -d --rm --name otp-router-sql-probe -e POSTGRES_USER=research -e POSTGRES_PASSWORD=research-only-db -e POSTGRES_DB=research -p 127.0.0.1::5432 postgres@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995
docker port otp-router-sql-probe 5432
docker exec otp-router-sql-probe pg_isready -U research
```

Wait until PostgreSQL reports that it accepts connections. Set `RESEARCH_DATABASE_URL` to `postgres://research:research-only-db@127.0.0.1:PORT/research`, replacing `PORT` with the assigned port. The password is for this disposable database only.

Run the compiler and experiment:

```sh
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --module NodeNext --target ES2022 --types node probe.mts
node probe.mts
```

The expected result is nine `PASS` lines and a successful resource-cleanup assertion. Stop the disposable database afterward:

```sh
docker stop otp-router-sql-probe
```

## Probe source

Source SHA-256: `633c6b7a5d0890dc8c8d7e381259a897903f5c61577ff367d52e5557d6e27445`.

```typescript
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Effect, Exit, ManagedRuntime, Redacted, Runtime } from 'effect'
import * as PgClient from '@effect/sql-pg/PgClient'
import { PgBoss, type Db } from 'pg-boss'
import pg from 'pg'

const url = process.env.RESEARCH_DATABASE_URL!
assert.ok(url, 'RESEARCH_DATABASE_URL is required')
const bossOptions = { connectionString: url, schema: 'boss_probe', schedule: false, supervise: false }

// A real child process claims a job and is killed before completing it.
if (process.argv[2] === 'crash-worker') {
  const childBoss = new PgBoss(bossOptions)
  childBoss.on('error', (e) => process.stderr.write(`${e.message}\n`))
  await childBoss.start()
  await childBoss.work('crash', { pollingIntervalSeconds: 0.5 }, async ([job]) => {
    process.send?.({ claimed: job.id })
    await new Promise(() => {})
  })
} else {
  const observer = new pg.Pool({ connectionString: url, application_name: 'otp_probe_observer' })
  const runtime = ManagedRuntime.make(PgClient.layer({
    url: Redacted.make(url), maxConnections: 8, applicationName: 'otp_probe_effect'
  }))
  let boss = new PgBoss(bossOptions)
  boss.on('error', (e) => process.stderr.write(`${e.message}\n`))
  let child: ReturnType<typeof fork> | undefined
  const report: string[] = []
  const passed = (name: string) => { report.push(name); console.log(`PASS ${name}`) }
  const exists = async (label: string) =>
    (await observer.query('select count(*)::int as n from probe_records where label=$1', [label])).rows[0].n
  const jobExists = async (id: string) =>
    (await boss.findJobs('atomic', { id })).length > 0

  // This captures the public Effect runtime inside the transaction. The adapter
  // never escapes this operation. The masked region is only local database work;
  // statement_timeout bounds its database wait. No provider call belongs here.
  const enqueue = (sql: PgClient.PgClient, label: string, beforeQuery?: () => Promise<void>) =>
    Effect.uninterruptible(Effect.gen(function* () {
      const scopedRuntime = yield* Effect.runtime<never>()
      const run = Runtime.runPromise(scopedRuntime)
      const expected = yield* sql<{ id: string }>`select txid_current()::text as id`
      const db: Db = {
        executeSql: async (text, values = []) => {
          if (beforeQuery) await beforeQuery()
          const actual = await run(sql<{ id: string }>`select txid_current()::text as id`)
          assert.equal(actual[0].id, expected[0].id, 'queue and app must share a transaction')
          const rows = await run(sql.unsafe(text, values).withoutTransform)
          return { rows: [...rows] }
        }
      }
      return yield* Effect.tryPromise(() => boss.send('atomic', { label }, { db }))
    }))

  const transaction = (label: string, body?: (sql: PgClient.PgClient) => Effect.Effect<unknown, unknown>) =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      return yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`set local statement_timeout = '3s'`
        yield* sql`insert into probe_records(label) values (${label})`
        const id = yield* enqueue(sql, label)
        assert.ok(id)
        if (body) yield* body(sql)
        return id
      }))
    })

  try {
    console.log(JSON.stringify({ node: process.version, postgres: (await observer.query('show server_version')).rows[0].server_version }))
    await observer.query('create table probe_records(label text primary key)')
    await boss.start()
    await boss.createQueue('atomic')

    // Uncommitted work is invisible from another PostgreSQL connection.
    let committedId = ''
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`set local statement_timeout = '3s'`
        yield* sql`insert into probe_records(label) values ('commit')`
        committedId = (yield* enqueue(sql, 'commit'))!
        yield* Effect.tryPromise(async () => {
          assert.equal(await exists('commit'), 0)
          assert.equal(await jobExists(committedId), false)
        })
      }))
    }))
    assert.equal(await exists('commit'), 1)
    assert.equal(await jobExists(committedId), true)
    passed('same transaction identity, pre-commit invisibility, atomic commit')

    let rolledBackId = ''
    const rollback = await runtime.runPromiseExit(Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`insert into probe_records(label) values ('rollback')`
        rolledBackId = (yield* enqueue(sql, 'rollback'))!
        return yield* Effect.fail('intentional rollback')
      }))
    }))
    assert.ok(Exit.isFailure(rollback))
    assert.equal(await exists('rollback'), 0)
    assert.equal(await jobExists(rolledBackId), false)
    passed('typed failure rolls back application row and queued job')

    const sqlError = await runtime.runPromiseExit(transaction('sql-error', (sql) =>
      sql`insert into probe_records(label) values ('commit')`))
    assert.ok(Exit.isFailure(sqlError))
    assert.equal(await exists('sql-error'), 0)
    assert.equal((await boss.findJobs<{ label: string }>('atomic')).some(j => j.data.label === 'sql-error'), false)
    passed('SQL constraint failure rolls back both writes')

    const parallel = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      runtime.runPromiseExit(transaction(`parallel-${i}`, i % 2 ? () => Effect.fail('rollback half') : undefined))))
    for (let i = 0; i < parallel.length; i++) {
      assert.equal(Exit.isSuccess(parallel[i]), i % 2 === 0)
      assert.equal(await exists(`parallel-${i}`), i % 2 === 0 ? 1 : 0)
    }
    const parallelJobs = (await boss.findJobs<{ label: string }>('atomic')).filter(j => j.data.label.startsWith('parallel-'))
    assert.equal(parallelJobs.length, 6)
    passed('12 concurrent transactions preserve separate commit and rollback outcomes')

    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`insert into probe_records(label) values ('outer')`
        yield* Effect.exit(sql.withTransaction(Effect.gen(function* () {
          yield* sql`insert into probe_records(label) values ('inner')`
          yield* enqueue(sql, 'inner')
          return yield* Effect.fail('rollback savepoint')
        })))
      }))
    }))
    assert.equal(await exists('outer'), 1)
    assert.equal(await exists('inner'), 0)
    assert.equal((await boss.findJobs<{ label: string }>('atomic')).some(j => j.data.label === 'inner'), false)
    passed('nested savepoint rolls back its job while the outer transaction commits')

    // Trigger interruption after transactional enqueue and before commit.
    const abort = new AbortController()
    let cancelId = ''
    const interrupted = runtime.runPromiseExit(Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`insert into probe_records(label) values ('cancelled')`
        cancelId = (yield* enqueue(sql, 'cancelled'))!
        yield* Effect.sync(() => abort.abort())
        yield* Effect.never
      }))
    }), { signal: abort.signal })
    assert.ok(Exit.isFailure(await interrupted))
    assert.equal(await exists('cancelled'), 0)
    assert.equal(await jobExists(cancelId), false)
    passed('interruption before commit rolls back both writes')

    // Cancellation during the Promise bridge is deferred until local SQL settles.
    const midAbort = new AbortController()
    const midResult = await runtime.runPromiseExit(Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`set local statement_timeout = '3s'`
        yield* sql`insert into probe_records(label) values ('mid-cancel')`
        yield* enqueue(sql, 'mid-cancel', async () => { midAbort.abort(); await delay(30) })
        yield* Effect.never
      }))
    }), { signal: midAbort.signal })
    assert.ok(Exit.isFailure(midResult))
    assert.equal(await exists('mid-cancel'), 0)
    assert.equal((await boss.findJobs<{ label: string }>('atomic')).some(j => j.data.label === 'mid-cancel'), false)
    assert.equal((await observer.query("select count(*)::int as n from pg_stat_activity where application_name='otp_probe_effect' and state='idle in transaction'")).rows[0].n, 0)
    passed('interruption during the bridge leaves no committed row, job, or idle transaction')

    // A fresh pg-boss instance recovers delayed work from the same database.
    await boss.createQueue('delayed')
    const delayedId = await boss.send('delayed', { attemptId: 'research-only' }, { startAfter: new Date(Date.now() + 1200) })
    await boss.stop({ graceful: true })
    boss = new PgBoss(bossOptions)
    boss.on('error', (e) => process.stderr.write(`${e.message}\n`))
    await boss.start()
    assert.equal((await boss.fetch('delayed')).length, 0)
    await delay(1400)
    const due = await boss.fetch('delayed')
    assert.equal(due[0]?.id, delayedId)
    await boss.complete('delayed', due[0].id)
    passed('delayed job survives a queue instance restart and respects its due time')

    // Kill an actual worker process after claiming a job, then recover its lease.
    await boss.createQueue('crash', { expireInSeconds: 2, retryLimit: 1, retryDelay: 0 })
    const crashId = await boss.send('crash', { attemptId: 'crash-research-only' })
    child = fork(fileURLToPath(import.meta.url), ['crash-worker'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    child.stderr?.on('data', data => process.stderr.write(data))
    const claimed = await Promise.race([
      once(child, 'message'),
      delay(10000).then(() => { throw new Error('child did not claim job') })
    ])
    assert.equal(claimed[0].claimed, crashId)
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    child = undefined
    await delay(2200)
    await boss.supervise('crash')
    const recovered = await boss.fetch('crash', { includeMetadata: true })
    assert.equal(recovered[0]?.id, crashId)
    assert.equal(recovered[0]?.retryCount, 1)
    await boss.complete('crash', recovered[0].id)
    passed('SIGKILL after job claim permits recovery after lease expiry')

    console.log(JSON.stringify({ result: 'passed', checks: report.length, report }))
  } finally {
    child?.kill('SIGKILL')
    await boss.stop({ graceful: true })
    await runtime.dispose()
    assert.equal((await observer.query("select count(*)::int as n from pg_stat_activity where application_name='otp_probe_effect'")).rows[0].n, 0)
    await observer.end()
    console.log('CLEANUP Effect runtime released its PostgreSQL connections')
  }
}
```
