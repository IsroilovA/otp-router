# External-code delivery example

For server integration, start with the [HTTP walkthrough](../http/README.md). This private engine example uses supported exports and a fake provider. It sends no real messages and requires no verification key. Use a fresh disposable PostgreSQL database; demo keys are fixed and public.

```sh
pnpm build
docker run --rm -d --name otp-external-demo -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=demo postgres:18.6
DATABASE_URL=postgres://postgres:demo@127.0.0.1:55432/postgres node examples/external-code/run.ts
docker rm -f otp-external-demo
```

Wait for PostgreSQL readiness before running the script. It exercises code attachment, fake-provider acceptance, and closure. Repeat runs share recipient cooldowns and rolling budgets; wait at least 30 seconds between runs.

Follow the [external-delivery contract](../../docs/engine.md#external-delivery). The caller owns verification; provider acceptance and closure do not authenticate a recipient.
