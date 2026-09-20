# Provider and extension contracts

Status: implementation contract. Validate exported types and examples against the selected Effect version.

## Provider identity and setup

A plugin describes a provider integration. A configured instance binds that plugin to credentials, sender settings, and other provider-specific options. Multiple instances of the same plugin may coexist.

Register plugins explicitly in typed startup configuration. Plugin construction uses Effect Layers and resolves its dependencies before it enters the active provider registry. Each ready instance exposes operations without undeclared application-service requirements.

Custom packages are installed in the router deployment image and registered by startup configuration. The standard image already includes built-in adapters. See [custom-provider deployments](operations.md#custom-provider-deployments) for packaging and runtime configuration.

Validate local configuration before accepting traffic. Reject duplicate instance IDs, unsupported contract versions, missing required configuration, and policies that reference unknown instances. A provider's live account check is a separate operation because it may require network access or incur a charge.

| Contract element | Purpose |
| --- | --- |
| Plugin ID and version | Identify the integration package and implementation. |
| Provider-contract version | Declare compatibility with the router's public provider API. |
| Instance ID | Reference a configured account and sender from routing policies. |
| Channel identifier | Describe the medium using an extensible identifier rather than a closed built-in-only enumeration. |
| Delivery constraints | Declare supported code formats, delivery timing limits, a required default send timeout under D092, and documented idempotency guarantees. |
| Configuration schema and Layer | Validate settings and construct scoped resources. |

All adapters receive normalized E.164 phone numbers. Provider wire formatting cannot change recipient quota identity. Custom channels do not add other recipient types in v1.

## Sending

`send` returns an Effect with typed failures. Success means acceptance, not delivery or verification. Pass only the fields in [the extension contract](#extension-contract-v1), never whole database records or arbitrary application metadata.

Adapters send the router-generated code unchanged and validate it against their constraints. Return normalized acceptance metadata and a provider request ID when available; never persist raw responses.

## Send timeout

Every adapter declares a positive finite `defaultSendTimeoutMs`, chosen from documentation and integration tests. An instance may override it with `sendTimeoutMs`; its adapter default must still be valid. There is no universal default.

The core enforces one deadline over the entire send, bounded by remaining challenge lifetime. It checks provider minimum delivery windows and snapshots the configured timeout. Internal network calls do not receive fresh budgets. The core derives the remaining budget from a database-time eligibility sample, then subtracts elapsed monotonic time while the dispatch gate and provider call run. Adapters must honor `remainingDeliveryMs` and must not create a new network budget.

Connect interruption to transport cancellation where supported. Timeout without definitive evidence leaves uncertainty and retains the reservation. It never authorizes resend or fallback. Late responses and authenticated callbacks follow normal state rules.

## Typed failures

Under D099, model expected provider failures as distinct tagged types with typed fields for acceptance certainty and diagnostics. Every expected send failure must distinguish error category from acceptance certainty. Validate external provider data before mapping it into these types; never infer failure categories by matching generic exception message text.

| Category | Meaning and handling |
| --- | --- |
| Recipient unavailable for the channel | Definitive channel-specific rejection can advance the configured route. |
| Invalid recipient input | Reject the request; trying every provider will not fix invalid application input. |
| Throttled | On definitive rejection, advance without automatically retrying. Preserve provider restrictions for later explicit sends. Unknown acceptance remains uncertain. |
| Invalid credentials or account configuration | On definitive rejection for invalid credentials or depleted balance, report an operator error and advance without retrying that provider under D055. Unknown acceptance still follows uncertain-outcome rules. |
| Temporary provider failure | Advance only on definitive rejection or final delivery failure. Otherwise preserve uncertainty. Never automatically repeat the send. |
| Unknown outcome | Persist uncertainty. Follow the accepted uncertain-delivery policy rather than assume failure. |

The failure also carries a redacted diagnostic code, optional retry time, and whether the provider is known not to have accepted the request. A generic timeout or HTTP status must not manufacture certainty. Preserve defects and interruption as distinct Effect causes; do not turn every unexpected failure into an automatic fallback.

Adapter idempotency declarations must document key scope, retention, and what response proves deduplication. Provider idempotency does not authorize automatic send retries in v1. A new user-requested resend or selection is a different delivery record and uses a new provider idempotency key. Replaying the same router API operation reuses its stored result without another send.

## Optional capabilities

Sending is required. An adapter may expose an authenticated callback handler when the provider supports one. Under D090, automatic provider status polling is deferred and is not part of the v1 adapter contract. Under D053, add paid preflight or remote cancellation only for a verified built-in use case. An absent method means unsupported; no general capability-negotiation protocol is needed.

If added, eligibility checks must declare cost and side effects. Paid preflight participates in send accounting. Workers do not query providers for status during recovery. Reconciliation uses received authenticated callbacks, persisted correlation data, or a send response that arrives late; unresolved delivery stays unconfirmed. Reading our challenge-status endpoint reads stored state and does not trigger a provider lookup.

Callback processing verifies the provider's authentication using raw body bytes and required request metadata before normalizing events. It must support duplicates and out-of-order reports. The core correlates events with delivery records and applies state changes. A delivery report cannot mark a challenge verified.

Local challenge cancellation does not require provider cancellation support and cannot recall a message already accepted by an external service.

## Shared conformance tests

Every built-in provider and third-party example must exercise configuration failures, accepted sends, definite rejection, uncertain acceptance, provider throttling restrictions, timeouts, interruption, and unsupported operations. Test callback authentication for adapters that implement it. Verify that missing receipts and worker recovery do not start provider polling.

Test that cancellation does not imply non-delivery. Verify that automatic send retries in provider SDKs and transports are disabled, even when provider idempotency is supported. Check that provider responses cannot leak codes into logs or stored diagnostics. Use fake transports for fault cases and separately configured provider smoke tests for live behavior.

## Custom routing selection

A routing selector is an Effect that runs during challenge creation. It receives the normalized phone number, purpose, requested or default locale, and bounded context from the trusted backend. It returns an ordered subset of the selected policy's registered, permitted provider-instance IDs, or explicitly rejects creation. It cannot return policy overrides. Configuration controls expiry, guess and send limits, cooldown, manual-selection permissions, templates, and locale fallback.

For example, a policy permits Telegram, WhatsApp, and SMS. A selector may return Telegram then SMS for an Uzbekistan number, WhatsApp then SMS for another supported destination, or reject an unsupported destination. An excluded provider is unavailable for that challenge, including explicit user selection.

Validate the returned route and persist it in the serializable policy snapshot before delivery starts. Resend, manual selection, fallback, and worker recovery use the saved route without rerunning the selector. Completed idempotent create replays reuse the saved result. Do not persist executable functions or credential values.

Initial manual selection is validated after route selection. A requested provider must be in the saved route and allowed by policy. Later manual choices must also remain eligible at action time. Reject an excluded choice without sending; an initial rejected choice creates no challenge or job. A channel choice resolves only among providers in the selected route.

The configurable selector timeout defaults to 2,000 ms and must be positive and finite. One deadline covers the entire execution, including external reads. On timeout, interrupt cooperative work and discard late results; create no challenge or job. Callers may retry with the same operation key.

Run selectors outside database transactions. Concurrent uncommitted requests may execute them more than once, so selectors must not send messages or perform paid or business actions. The create transaction commits only one snapshot and idempotency result. See [transaction boundaries](data-model.md).

Return `503 temporarily_unavailable` for selector failure, timeout, or an invalid result; `422 delivery_unavailable` for intentional rejection; and `422 delivery_option_not_allowed` for an excluded manual choice. Create no challenge or job and never substitute a default route. Keep raw errors in redacted diagnostics.

Selectors cannot expand beyond the policy's permitted provider set or weaken verification and abuse checks. Invalid routes fail before creation. Startup emergency disables can still block a provider after snapshot creation under D049. Regional preferences belong in the selector; no built-in regional or automatic provider-health engine is provided under D075.

## Diagnostics

Public lifecycle hooks are deferred. Use [structured logs and metrics](operations.md#diagnostic-fields-and-access) for diagnostics, not business authorization.

## Templates and localization

D072 accepts adapter-specific template configuration and one deployment-wide localization configuration with `defaultLocale` and ordered `fallbackLocales`. There are no per-policy or per-template fallback chains in v1. English examples do not restrict supported locale identifiers.

For each challenge, start with the requested locale, or `defaultLocale` when omitted, then append `fallbackLocales` and remove duplicates while preserving order. Resolve the first compatible configured template separately for each provider in the selected route. For example, with default `en` and fallbacks `["ru", "en"]`, a request for `uz` tries `uz`, `ru`, then `en`; a request for `ru` tries `ru`, then `en`. Never add an implicit language or infer a provider language code from a locale without an explicit adapter mapping.

Providers may resolve different languages within one challenge. Persist the requested or default locale and each selected provider's resolved locale and non-secret template settings in the challenge's policy snapshot. Resend, manual selection, and fallback reuse those choices. Remote provider-managed template content remains external; operators must treat incompatible remote template changes according to the configuration drain procedure.

Resolve the complete selected route before committing a challenge. If any provider requiring templates has no compatible candidate, reject creation without queueing a send or silently dropping that provider. Adapters that do not require configurable templates declare that fact and are exempt from template-coverage checks.

Each adapter validates its [template schema](#extension-contract-v1). The core provides no general template language, conditionals, loops, or executable template bodies.

### Startup and live validation

Under D073, every service role validates configuration locally before accepting work. Check required fields and secret presence, unique provider IDs, policy references, adapter template schemas, supported placeholders, explicit language mappings, default or fallback coverage for every policy-eligible provider requiring templates, and known code-format and timing constraints. Custom selectors can return only providers from that validated permitted set. Invalid configuration fails startup.

Validate remote credentials, funding, senders, templates, and delivery through separate live diagnostics or integration tests. Distinguish read-only from paid checks. Remote success is not a startup prerequisite; outages must not prevent verification of existing challenges.

### Expiry wording

Under D078, default message examples include the code without a relative validity claim. The application displays its countdown from `expiresAt` and `serverTime`. Adapters receive the unchanged absolute expiry to derive any supported provider delivery deadline. An optional expiry rendered in a message needs an explicit timezone and adapter-compatible format, and must remain accurate on resend. Do not substitute resend eligibility or HTTP `Retry-After` for code expiry, and do not send a fixed lifetime footer that overstates the remaining validity.

## Trust and supported extension points

Plugins are trusted server code with process access; operators choose what to install. Public v1 extensions are providers and routing selectors. Verification, abuse enforcement, storage, and queue implementations remain internal.

## Extension contract v1

Export configuration helpers, provider definitions, and selector types from the single package's documented entry points. Set the provider contract major to `1`. Reject another major at startup. Keep the exact supported Effect peer range in package metadata and test the example with that range. A package version alone does not establish provider-contract compatibility.

Use schema-derived, readonly types. Brand validated identifiers, normalized phones, and durations so raw strings and numbers cannot be passed directly into domain operations. Adapter-specific configuration and template types remain generic; registration captures those types in closures. Do not erase heterogeneous registrations with `any` or expose database services to extensions.

| Definition | Required fields and operations |
| --- | --- |
| Provider definition | `id`, implementation `version`, `contractVersion: 1`, `channel`, `configSchema`, `templateSchema` when needed, code and delivery constraints, `defaultSendTimeoutMs`, and a scoped `make` Layer. |
| Ready provider | `send(input)` returning `Effect<SendAccepted, ProviderSendError>` with no unresolved application-service requirements; optional authenticated callback decoding. |
| Send input | `challengeId`, `deliveryId`, normalized `recipient`, `code`, `expiresAt`, resolved `locale`, typed `template` when required, nonnegative `remainingDeliveryMs`, and optional supported provider idempotency key. `remainingDeliveryMs` is the net delivery budget after the database-time eligibility sample and monotonic dispatch-gate elapsed time. Secrets are runtime-only values and must not be serializable diagnostics. |
| Send accepted | Optional `providerRequestId` plus normalized acceptance evidence. A response carrying verified delivery evidence may also provide a normalized delivery event. Raw payloads are never the return contract. |
| Send error | Tagged category from the typed-failure table, `acceptance: "not_accepted" | "unknown"`, allowlisted `diagnosticCode`, and optional `retryAt`. Final post-acceptance delivery failure is an event, not a retrospective rejection. |
| Selector input | Normalized `recipient`, `purpose`, requested or default `locale`, and bounded readonly `routingContext`. |
| Selector result | `{ _tag: "Route", providerInstanceIds }` with a nonempty, duplicate-free ordered subset, or `{ _tag: "Reject" }`. Its Effect has a typed execution-failure channel; defects and interruption stay separate. |
| Callback input | Bounded raw body bytes, method, path, query, and required headers. The adapter authenticates before producing normalized events or a protocol handshake response. |
| Callback event | Instance-scoped deduplication key, correlation reference, normalized delivery status, and optional provider event time. The core supplies receipt time. A batch must be validated and durably ingested before acknowledgement. |

A callback method must produce a typed authentication or format failure rather than an empty successful event list for invalid input. For providers without stable event IDs, derive deduplication from authenticated correlation, status, and provider event time; never use receipt time. Duplicate events cannot repeat routing transitions even after inbox cleanup. Bound callback batches and unmatched inbox retention. No callback operation receives permission to verify a code or call another provider.

Built-in template configuration has only the fields each integration needs. Telegram declares no configurable template. Play Mobile uses `{ text }` with exactly one `{{code}}` placeholder and rejects unknown placeholders. Meta uses `{ name, languageCode, codeButtonIndex }` for a copy-code authentication template; map the same router code to its body and configured button. Validate the approved remote structure in onboarding. One-tap, zero-tap, template creation, and general arbitrary component mapping are not needed for the first built-in implementation. Custom adapters retain their own template schemas. Unsupported remote configurations fail explicitly.

The implementation must include a small custom text adapter and selector using only documented exports. Compile and run them in a separate deployment fixture with the installed package, then build and run its custom image. Examples cannot rely on private source imports or undeclared host dependencies.
