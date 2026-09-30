# Project administration

Start the [local server](../../docs/running.md), then provision its demo project, fake account/instance, policy, and assignments:

```sh
pnpm build
node --env-file=.env examples/admin/run.ts
```

The script uses the separate `OTP_ROUTER_ADMIN_KEY`, creates the project and initial backend grant atomically, reads the current ETag, retrieves audit, and provisions separately versioned secrets and explicit runtime assignments. Repeating the same script replays creation without duplicating grants or audit. It sends no messages.

For the authorized configuration, also set `OTP_ROUTER_PROJECT_AUTHORIZATION=required`. Keep this choice unchanged when retrying the same creation key. For subsequent changes, retain the key, payload, and original ETag until the outcome is known; reread the project after a revision conflict. See [administration contracts](../../docs/projects.md).

For a real adapter example, start with `builtins.config.ts` and run `node --env-file=.env examples/admin/telegram.ts`. Set `OTP_ROUTER_TELEGRAM_ACCOUNT_ID` to the stable upstream account identity, `OTP_ROUTER_TELEGRAM_TOKEN`, and `OTP_ROUTER_TELEGRAM_CALLBACK_URL` to the public HTTPS `/webhooks/demo-telegram-sender` URL. The script provisions shared limits, separate send/callback versions, a sender, and the `demo-telegram-login` policy. It sends no messages. Keep its initial inputs unchanged on retries; runtime reads never return the token. Follow [provider setup](../../docs/provider-setup.md) before directing callers to the policy.
