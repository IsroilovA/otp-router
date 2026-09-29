# Project administration

Start the [local server](../../docs/running.md), then provision its demo project:

```sh
pnpm build
node --env-file=.env examples/admin/run.ts
```

The script uses the separate `OTP_ROUTER_ADMIN_KEY`, creates the project and initial backend grant atomically, reads the current ETag, and retrieves audit. Repeating the same script replays creation without duplicating grants or audit. It sends no messages.

For the authorized configuration, also set `OTP_ROUTER_PROJECT_AUTHORIZATION=required`. Keep this choice unchanged when retrying the same creation key. For subsequent changes, retain the key, payload, and original ETag until the outcome is known; reread the project after a revision conflict. See [administration contracts](../../docs/projects.md).
