# Projects and administration

Every managed challenge and external delivery belongs to a database-owned project. Create projects through the authenticated administration API without restarting API or worker processes. A fresh database has no projects. Startup never provisions or overwrites project settings or grants.

The integrating application authenticates its customers, authorizes their business actions, and chooses the project. Customer accounts and customer credential management remain its responsibility.

## Identity and access

Deployment configuration defines backend principals with stable IDs and independent secret credentials. Database grants give those principals access to projects. A request selects its project in the URL and authenticates with a Bearer credential; the engine checks the current grant inside the transaction. A project identifier, operation reference, or customer credential alone grants no access.

A principal granted several projects is trusted to select among them. Credentials belong on trusted servers and travel over TLS or a private network. Credential rotation preserves principal identity, grants, replay identities, quotas, and verification bindings. Revocation cuts off subsequent project access immediately after commit. Regrant creates a new permission lifetime; old send intents cannot use it.

All public reads and mutations are project scoped. References owned by another project behave like absent references. Request keys are independent between projects and between managed and external capabilities. The same recipient, purpose, or request key cannot join two projects' operations. Another currently granted backend may read, verify, close, or explicitly send an operation in that project.

Provider callbacks cannot choose project ownership. Authenticated evidence belongs to its correlated operation. Public events and history identify their project. A deployment webhook receiver is trusted for every project and must preserve that attribution.

## Administration authority

Administrators use separately configured credentials. Administrator credentials do not grant backend access, and backend credentials do not grant administrative access. Configuration restricts administrator actions, exact project IDs or literal creation prefixes, grantable principal IDs, editable settings, aggregate-limit ceilings, and permission to disable authorization. Prefix scopes apply to creation and subsequent administration of matching projects; underscores and other identifier characters are literal, never wildcards.

Creation sets project settings and initial backend grants atomically. Updates replace the complete settings object. Field permissions apply to changed settings; creation requires permission to set every setting. Permission to disable authorization is required when creating a disabled project or switching authorization off; changing other settings of an already disabled project does not require it. Grant additions and removals both require authority over the affected principal. Project authorization cannot be disabled below the configured floor, even by an administrator otherwise permitted to disable it. Required authorization needs a configured authorizer.

The API cannot modify administrator permissions, credentials, policies, or providers. Those remain deployment configuration. See [HTTP administration](api.md#administration) for concurrency and retry rules and the [administration example](../examples/admin/run.ts) for provisioning.

Every project may use any configured policy that supports its requested purpose and capability. There are no project-policy grants or allowlists. Selectors receive project identity and can only narrow the configured route. Operations capture their authorization requirement when prepared or created; later changes apply only to new operations.

## Lifecycle and sends

Projects start active. Active projects may be suspended, suspended projects reactivated, and either state retired. Retirement is irreversible; administrators can still manage grants for historical access. Project IDs remain reserved permanently, including after history retention expires.

Suspension and retirement reject new preparation, creation, attachment, explicit sends, and uncommitted automatic fallback. They preserve authorized reads, verification under its original binding and deadline, cancellation/closure, callbacks, late evidence, and history reconciliation. Grant revocation denies all subsequent backend access under that grant; other granted principals retain access.

Each explicit send action admits an intent bound to the backend grant and the project's send epoch. Automatic fallback inherits that intent. Suspension or retirement invalidates outstanding intents; reactivation never revives them. Revocation likewise permanently invalidates the revoked grant's intents. New explicit actions after reactivation or regrant receive new authority and retain the operation's original code and deadline.

Transaction commit defines admission and dispatch ordering. Administration waits for earlier shared project checks to commit. After an administrative change commits, later dispatch commitments cannot use invalidated authority. A previously committed send may still invoke its provider or complete after the administrative response. Its uncertainty and quota reservations remain intact. Late failures cannot restart an invalidated fallback chain. Late approvals remain observable as unused-attempt evidence.

Temporary authorizer-imposed blocks are separate from administrative suspension. Immediate enforcement does not depend on asynchronous cleanup.

## Limits and history

Normal recipient creation, send, guess, and cooldown usage is scoped to the project. Managed and external delivery share admission and send usage within that project. Changing purpose or policy does not reset that usage.

Project aggregate limits apply across both capabilities, using current settings at dispatch without resetting existing usage. Shared provider-account limits and deployment ceilings remain independent protections across projects. Limits count provider invocations, not monetary cost. The integrating application's public endpoints still need their own abuse controls.

Every actual administrative change appends one immutable audit event with actor, action, affected resources, and resulting project revision in the same transaction. No-op mutations and receipt replays append nothing. Audit is retained indefinitely and retrieved through scoped pagination. It excludes credentials, OTPs, recipients, arbitrary request bodies, and other secrets.
