# Projects and backend identity

Every managed challenge and external delivery belongs to an explicitly configured project. A single-project deployment uses the same contract with one project. There is no implicit project or deployment-wide application credential.

The integrating application authenticates its customers, authorizes their business actions, and chooses the project. Customer accounts and customer API-key lifecycle remain its responsibility.

## HTTP trust boundary

Configure backend service principals with stable IDs, independent secret credentials, and explicit project grants. A request selects its project in the URL and authenticates with a Bearer credential. The server validates that the authenticated principal may act for that project before calling the engine. A project identifier, operation reference, or customer credential alone grants no access.

A principal granted several projects is trusted to select among them. Use separate principals when backends need narrower privileges. Credentials belong on trusted servers and travel over TLS or a private network. Rotation changes credentials, never project identity, idempotency scope, or verification bindings.

All public reads and mutations are project scoped. References owned by another project behave like absent references. Request keys are independent between projects and between managed and external capabilities. The same recipient, purpose, or caller request key cannot join two projects' operations.

Workers resolve ownership from durable operation references. Authenticated provider callbacks resolve ownership through provider-instance/attempt correlation, never through a callback-supplied project identifier. Public events and attempt history carry explicit project attribution. A deployment webhook receiver is trusted for every configured project; it must preserve that attribution in its own projections.

## Provisioning and policies

Project provisioning and policy grants are deployment configuration. Configuration is immutable while running. Each project explicitly enables or disables send authorization and has its own aggregate send limits. Selectors receive project identity and can only narrow the permitted route.

A project can have no policy grants while retained operations finish and remain readable. Keep its identity configured for that lifecycle; never recycle a project ID for another customer. Policy changes and removal of provider configuration follow the existing drain procedure. There is no provisioning API or customer account database.

## Limit scopes

Normal recipient creation, send, guess, and cooldown usage is scoped to the project. Managed and external delivery share admission and send usage within that project. Changing purpose or policy does not reset that usage.

Project aggregate send limits apply across both capabilities. Shared provider-account limits and deployment send ceilings remain independent, configurable protections across projects. They may deliberately block several projects at once; ordinary activity consumes no other project's normal recipient allowance. The integrating application's public endpoints still need their own abuse controls.
