# Custom adapter consumer

This workspace example imports provider contracts from `@otp-router/engine/providers` and selector types from `@otp-router/engine/config`. It compiles against emitted package declarations and executes a deterministic text sink without sending a message.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @otp-router/engine build
pnpm --filter otp-router-custom-adapter-example build
pnpm --filter otp-router-custom-adapter-example test
docker build -f examples/custom-adapter/Dockerfile -t otp-router-custom-adapter:local .
docker run --rm otp-router-custom-adapter:local
```

There is one workspace lockfile. A deployment configuration registers `TextProvider.make(...)` and `textSelector`. Packages remain private; there is no registry publishing step.
