# Deterministic local configuration

This configuration uses the built-in deterministic fake provider. It accepts sends and never contacts a messaging provider. It is suitable for local HTTP and PostgreSQL verification once the service has been built.

Use the persistent local key-generation commands in [the running guide](../../docs/running.md). They create the API key, callback secret, and four independent cryptographic keys in a mode-600 `.env`. Keep those keys across restarts so the existing database remains readable.

Use an international test number such as `+14155552671` in local requests. The fake provider does not deliver an SMS or message, and the service must not print the generated code.

The [built-in configuration](builtins.config.ts) registers real providers. Follow [provider setup](../../docs/provider-setup.md) and use `--check-config` for local validation before enabling real traffic.
