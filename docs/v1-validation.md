# Private v1 validation record

This record covers the local `otp-router` 0.1.0 implementation on 2026-09-20. Distribution remains private. It records deterministic fake-provider and PostgreSQL evidence, not approval for production provider accounts.

## Versions and compatibility

| Component | Tested version or contract |
| --- | --- |
| Host runtime | Node.js 26.8.2, pnpm 12.5.1, macOS Darwin 25.6.0 |
| Standard and custom images | Node.js 24.21.0, Docker Engine 29.7.2 |
| Database | PostgreSQL 17.11. PostgreSQL 17 is the supported major for this v1. |
| Application dependencies | Effect 3.22.2, `@effect/sql-pg` 0.53.0, pg-boss 12.33.2. Exact dependencies are in the lockfile. |
| Router schema | Version 2, through `0001_initial_schema` and `0002_deployment_controls` |
| HTTP / queue job / challenge snapshot / provider contract | v1 / 1 / 1 / 1 |
| Upgrade policy | Drain and restart. No cross-release rolling compatibility is claimed. |

Node.js 24 is the runtime baseline. The existing CI matrix runs Node.js 24 and 26. Local checks covered the Node.js 26 host and Node.js 24 images. Other PostgreSQL majors have not been qualified.

The lockfile SHA-256 is `6b6aa278bd374c1afaf3811dbf1f5805640c5db5bacfa1547b85e8585065cc3b`. The measured source digest is `08fe1dbec422b002046c41d6f52b68435a7b98f02cb2a6ab8afe6baea0f25c94`, computed by concatenating regular `src` files in bytewise sorted path order and hashing the contents. The [benchmark record](benchmark.md) identifies the measured workload and environment.

## Artifact checks

The standard image started with an empty disposable PostgreSQL database, migrated before readiness, and completed HTTP create, queued fake acceptance, and cancellation. It ran as UID 1000. Its logs contained neither the API key nor the synthetic recipient. Its local image digest was `sha256:bb8f02d900d59207afa1bca2ec1d5c8786e071e62208da0157b875a8480a8545`.

The packed private tarball had SHA-256 `6a3194c20378c36fe58acb5799fe897fcad12f344aeb2e9d7f2582efb2085949`. A temporary installation outside the repository compiled the [external adapter and selector](../examples/custom-adapter/README.md) using only public exports, with strict TypeScript and `skipLibCheck: false`. Its host and container smoke entrypoints both returned `{"selector":"Route","provider":"custom_text_sink"}`. The custom image digest was `sha256:af392bd469db7f0adb295bd8972d8c6802e7f88a66013bd20e12ccfdebd5f890`.

These are local build digests, not registry publications. Rebuilding can change them because container base tags and generated archive metadata can change. The temporary installations, test containers, networks, and verification images were removed after verification.

## Compose follow-up

The 2026-09-20 Compose check built the standard image and started PostgreSQL plus the combined API/worker in an isolated project. HTTP creation reached fake-provider acceptance through the queue, replay returned the original response, and unauthenticated access failed. The application ran as `node`, its configuration mount was read-only, and the health port was not published. After `down` and `up` with the same volume and keys, readiness recovered and delivery state and replay remained intact. The test removed its containers, volume, network, image, and temporary secrets.

This check exposed a restart failure when the database role and application schema both used `otp_router`. Migration startup now explicitly uses `public.effect_sql_migrations`, so PostgreSQL's search path cannot create a second history table. A real PostgreSQL regression test failed before the fix and passed afterward. Applied migration files are unchanged. This startup fix postdates the source and artifact digests above; those remain records of the earlier measurements.

## Reproduce

From a checkout with Docker running:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm exec vitest run tests/process.test.ts
pnpm exec vitest run --config vitest.benchmark.config.ts --reporter=verbose
```

The process suite demonstrates HTTP create, durable queued delivery, and verification with a private temporary fake-provider code sink. The normal tests own disposable PostgreSQL containers and remove them afterward. They do not use the persistent development database. The benchmark runs separately for at least fifteen minutes.

Use the [running guide](running.md) for persistent local startup, generated independent secrets, separate process roles, container startup, API examples, and recovery commands. Use [provider setup](provider-setup.md) for built-in configuration and local checks that do not send messages.

## Evidence and limits

The [acceptance map](implementation-evidence.md) links all 109 product scenarios to tests or explicit inspections. The final `pnpm test` run passed all 90 tests in 10 files in 44.29 seconds, including 9 process tests and 2 database fault tests. TypeScript, strict Effect diagnostics, typed linting, formatting, and emitted-output builds pass. The benchmark reports HTTP latency, throughput, queue delay, resource samples, cleanup lag, and recovery.

The local tests do not establish live provider credentials, approved Meta templates, real receipt or callback behavior, production-data migration timing, or database failover under network partitions at commit. Pool acquisition wait is not separately instrumented in the load benchmark. Detailed capacity metrics describe the earlier complete baseline. The final-source 15-minute phase completed, but a later benchmark assertion lost its latency and resource summaries. Its corrected exact-cohort cleanup recovery passed separately, expiring all 250 challenges and erasing their secrets in 16.27 seconds. Live provider checks require explicit authorization and designated recipients. No real provider sends occurred during this implementation.
