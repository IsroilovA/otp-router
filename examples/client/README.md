# TypeScript HTTP client example

Start the local fake-provider server using the [running guide](../../docs/running.md), then run from the repository root:

```sh
pnpm build
OTP_ROUTER_API_KEY=your-local-backend-key node examples/client/run.ts
```

Set `OTP_ROUTER_URL` if the HTTP server is not at `http://127.0.0.1:3000`. Use the `demo` project and `login` policy from the example configuration. The example creates and cancels a managed challenge, replays its creation with the same key, creates and closes an external-code delivery, and reads its retained events. Fake providers send no messages; this example does not demonstrate receipt or successful verification.

Use [the npm package](../../packages/client/README.md) in your backend integration. Retain the key and original payload across ambiguous failures, and follow the [HTTP contract](../../docs/api.md) before choosing whether to retry.
