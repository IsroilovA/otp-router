# Configuration choices

Start from the [fake configuration](../examples/config/router.config.ts) or [built-in providers](../examples/config/builtins.config.ts). [Engine](../packages/engine/src/config/config.ts) and [server](../apps/server/src/config/config.ts) schemas own fields, defaults, and bounds; the entries and [.env.example](../.env.example) own environment mappings.

Configuration is trusted executable TypeScript. Install its imports with the deployment and keep secrets outside the image. Environment variables affect only fields the entry reads. Pass `--env-file` to Node to load a local secrets file. Configuration is immutable while running. Configure backend and administrator identities, administrator permission ceilings, and an authorization floor. Provision [projects and backend grants](projects.md) through administration. Project settings are database-owned.

## Policies

- Configure ordered provider instances and the purposes allowed to use each policy. Select routes according to cost, reachability, and account restrictions.
- Enable managed verification only where the router should generate and check codes. External delivery uses its own supplied deadline, bounded by the common policy lifetime.
- Choose deployment and provider send caps, and administer project limits, for account budgets. They count invocations, not exact monetary charges; automatic fallback consumes sends too.
- Enable manual provider/channel selection deliberately and restrict its choices when necessary. Selectors may narrow routes but cannot relax limits.
- Ensure timeouts, delivery windows, code formats, and locale templates fit every enabled capability. Use [provider setup](provider-setup.md) for remote account requirements.

API and worker roles validate a compatible policy, provider, principal, administrator-permission, and capability catalog before readiness. The live catalog is registered for each process lifetime; an incompatible catalog cannot join running replicas. Startup rejects missing principals still named by active grants, an unavailable authorizer required by retained active work or project settings, and projects below the authorization floor. Stop all roles before changing the catalog, following the [drain procedure](operations.md#configuration-changes).

Startup rejects malformed provider constraints, policies whose lifetime or code length cannot fit a routed provider, and provider budget or label references without a registered instance. Validate the full deployment entry before directing traffic to it.

## Database identity

A database belongs to one deployment and its stable recipient-lookup key. Keep both unchanged across restarts, and retain keys needed by stored data. Empty business tables do not reset that identity.

Use separate databases and secrets for development and production. Do not delete identity records or needed volumes to bypass compatibility failures. Follow [configuration changes and recovery](operations.md) for drains, restores, and key replacement.

## Validation

`--check-config` loads and validates the entry without core database access or sends. Custom configuration code can still have its own side effects.

`--check-schema` applies migrations and initializes database identity and queues; it changes the database and needs migration privileges. It does not open the application listener or send messages. See [running](running.md) for commands.
