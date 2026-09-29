# Custom adapter consumer

This workspace example builds a provider and selector using supported engine exports. Its text sink sends no messages. Follow the [extension contracts](../../docs/plugins.md) for adapter requirements.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @otp-router/engine build
pnpm --filter otp-router-custom-adapter-example build
pnpm --filter otp-router-custom-adapter-example test
docker build -f examples/custom-adapter/Dockerfile -t otp-router-custom-adapter:local .
docker run --rm otp-router-custom-adapter:local
```

Register the adapter and selector in the deployment configuration. The engine and adapter remain private workspace packages built into the image.
