# Deterministic local configuration

This configuration uses a fake provider that accepts sends without contacting a messaging service. Use it for local HTTP and PostgreSQL checks.

Generate local secrets using [the running guide](../../docs/running.md). Preserve them across restarts so stored data remains readable.

Use an international test number such as `+14155552671` in local requests. The fake provider does not deliver an SMS or message, and the service must not print the generated code.

The [built-in configuration](builtins.config.ts) registers real providers. Follow [provider setup](../../docs/provider-setup.md) and use `--check-config` for local validation before enabling real traffic.

Set `OTP_ROUTER_WEBHOOK_URL` and a separate `OTP_ROUTER_WEBHOOK_SIGNING_SECRET` to enable outbound updates. Follow [webhook setup](../../docs/webhooks.md#authentication-and-ingestion) and the [receiver example](../webhook-receiver/README.md).

Use [authorized.config.ts](authorized.config.ts) to require an external reservation before each fake provider invocation. Supply the authority collection URL and a dedicated credential; see the [authorization contract](../../docs/authorization.md).

Set a separate `OTP_ROUTER_ADMIN_KEY`. These entries configure identities and administration ceilings; they do not create projects or runtime resources. Run the [administration example](../admin/run.ts) after startup. With `authorized.config.ts`, set `OTP_ROUTER_PROJECT_AUTHORIZATION=required` when provisioning; its authorization floor rejects disabled authorization.
