# Configuration choices

Start from the [fake deployment](../examples/config/router.config.ts) or [built-in adapters](../examples/config/builtins.config.ts). [Engine](../packages/engine/src/config/config.ts) and [server](../apps/server/src/config/config.ts) schemas own deployment fields and bounds. Entries are trusted executable TypeScript; install their imports with the deployment and keep secrets outside the image.

Deployment configuration owns installed adapter implementations and schema support, versioned executable selectors, database connectivity, data-encryption keys, deployment identity, backend/administrator identities, permission ceilings, authorization integration, and hard safety ceilings. Environment variables affect only fields the entry reads. Configuration is immutable while a process runs.

Provider accounts, credentials, instance settings, policies, project settings, assignments, and shared allowances are administered in PostgreSQL. There is no static provider/policy catalog, startup provisioning, import path, or second source of truth. A fresh database has no projects or runtime resources. Follow [runtime configuration](runtime-configuration.md) and [project administration](projects.md) before enabling callers.

## Policies

Choose ordered instance IDs, purposes, managed/external capabilities, code and lifetime bounds, manual permissions, locale fallbacks, and automatic fallback mode through administration. Templates and locales belong to immutable instance revisions. Selectors may only narrow or reorder authorized steps; they cannot send or relax policy limits. Shared allowance scopes control account budgets across projects without resetting accumulated usage.

API and worker roles register a matching deployment-capability fingerprint before readiness. It covers installed adapter contracts/schema versions, selector identities/versions, deployment identities/permissions and safety settings. Runtime data edits do not change it. Startup rejects unsupported retained configurations, missing principals still named by active grants, unavailable required authorization, missing encryption/fingerprint keys, and projects below the authorization floor. Follow [deployment changes](operations.md#configuration-changes) when changing executable capabilities.

## Database identity

A database belongs to one deployment and stable recipient-lookup key. Keep both unchanged across restarts. Empty business tables do not reset that identity. Use separate databases and secrets for development and production; never delete identity records to bypass compatibility failures.

## Validation

`--check-config` validates the deployment entry without core database access or sends. Custom executable configuration can have its own side effects. Runtime administration validates resource schemas, references, constraints, and local template coverage; it does not test provider credentials remotely.

`--check-schema` applies the initial migration and initializes database identity and queues. It changes PostgreSQL and requires migration privileges, but opens no application listener and sends no messages. Old baselines are explicitly rejected; see [fresh-database installation](operations.md#database-upgrades).
