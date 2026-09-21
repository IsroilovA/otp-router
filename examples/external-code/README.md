# External-code delivery example

This standalone consumer uses supported exports and a fake provider. It sends no real messages and requires no verification key. Use a fresh disposable PostgreSQL database; demo keys are fixed and public.

```sh
pnpm build
docker run --rm -d --name otp-external-demo -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=demo postgres:18
DATABASE_URL=postgres://postgres:demo@127.0.0.1:55432/postgres node examples/external-code/run.ts
docker rm -f otp-external-demo
```

Wait for PostgreSQL readiness before running the script. It prepares a fixed deadline, attaches an externally supplied example code, waits for fake provider acceptance, prints only the safe snapshot, and closes the operation. Repeat runs share recipient cooldowns and rolling budgets; wait at least 30 seconds between runs.

Preparation guarantees durable handoff identity, not provider capacity. Submission commits queued work; provider acceptance is asynchronous. The external authority owns verification, authentication, and sessions. Closure only stops router work and erases recoverable secrets; it cannot recall an in-flight message and is never proof of verification.
