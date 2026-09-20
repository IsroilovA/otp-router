# Product specification

Status: the scope and behavior tied to accepted decisions are normative. Explicitly labeled proposals remain open.

## Purpose and scope

OTP Router generates and verifies phone-number codes and delivers them through an application-defined provider sequence. Applications may reorder or omit providers. The router must never use a channel excluded from the active policy.

V1 provides a standalone self-hosted HTTP service built with TypeScript and Effect on Node.js, using PostgreSQL. Each deployment serves one application. Browsers and mobile clients call the adopting application's backend.

Uzbekistan is the initial market. The core must not hard-code country restrictions or country-specific phone validation. Built-in providers are Telegram Gateway, direct Meta WhatsApp Cloud API, and Play Mobile SMS. External plugins use the same provider contract.

English examples ship first. Applications configure adapter-specific templates and one global locale fallback order under D072. Each provider resolves its own template at challenge creation; selected languages may differ across providers. Email OTP, TOTP, passkeys, account/session management, general messaging, an administration dashboard, and durable outward event delivery are outside v1. A provider marketplace remains a proposed exclusion.

## Responsibilities

The router owns code generation, verification, expiry, delivery attempts, routing, and abuse enforcement. The adopting application owns accounts, authorization, sessions, and the business action after verification. It binds each challenge to a login or action and consumes the verification result once.

Operators supply provider accounts, credentials, approved templates, and routing configuration. The default container runs the API and worker together, with optional separate roles. PostgreSQL is the only required external service. Configuration, documentation, and diagnostic CLI commands provide the v1 operator interface.

Typed TypeScript configuration loads at startup. It registers providers and named policies for purposes such as login or signup. Credentials come from environment variables or a secret store. A custom selector may choose the route at creation; the router persists a policy snapshot. Structured logs and basic metrics report operational outcomes. Public lifecycle hooks are deferred under D074.

See [architecture](architecture.md) for components, [dependencies](dependencies.md) for the selected stack, and [plugins](plugins.md) for extension contracts.

## Terms

- A channel is a delivery medium such as Telegram, WhatsApp, or SMS.
- A provider is a service that sends messages through a channel.
- A provider instance is one configured provider account.
- A policy defines eligible provider instances, their order, and fallback behavior.
- A challenge binds a code to a recipient, purpose, and application context.
- A delivery record tracks one requested dispatch through one provider instance, from pending work to its external outcome. It permits at most one send invocation. A resend creates a new record.
- Verification means the router accepted a submitted code. Delivery status cannot establish verification.

## Required behavior

Under D082, creation and user-requested delivery actions return after their state changes and background jobs commit. They never wait for provider acceptance or delivery. Responses distinguish queued work from external outcomes; current status reports subsequent delivery progress. Under D084, applications retrieve later updates through optional status queries. Verification returns its result directly; it does not wait for delivery confirmation or require polling. Outgoing application webhooks and live event streams are outside v1.

Confirmed rejection or final delivery failure advances to the next eligible provider. Uncertain delivery waits for an explicit user action. Timed fallback and automatic provider-send retries are excluded from v1 under D068-D069. Users can request resend through the current provider or the next provider. Resend remains supported after uncertain or confirmed delivery, subject to cooldown, expiry, provider eligibility, and shared limits. Policies may also enable manual selection at creation and on later sends. Fallback continues after the selected provider without automatic wraparound.

Fallback and resend preserve the code, expiry, and failed-guess count. Independent flows may have independent challenges for the same recipient. Under D081, all application mutations require an idempotency key. Retry the same operation with the same key; use a new key for a new user action. Completed replays do not repeat side effects or consume another guess. Idempotent create retries reuse the existing challenge. Recipient limits apply across challenges.

Delivery exhaustion leaves an otherwise active code verifiable. Cancellation blocks verification and pending sends but cannot recall a dispatched message. Logs and metrics are diagnostic observations, not a durable business-event feed.

The accepted numerical defaults, enforcement rules, and secret-retention periods belong in [security](security.md). [Routing](routing.md) defines lifecycle and delivery; [API design](api.md) defines operations and replay; [data model](data-model.md) defines record cleanup. State changes and limits must remain correct across concurrent processes and restarts.

## Acceptance scenarios

The outcomes below are acceptance criteria when backed by an accepted decision.

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| S001 | The first configured provider accepts the message. | Keep acceptance separate from delivery and verification. If delivery stays uncertain, wait for an explicit user action. Never advance merely because time has passed. |
| S002 | Telegram cannot deliver to the recipient. | Proceed to the next eligible configured provider when the adapter reports a definitive failure. |
| S003 | WhatsApp accepts the request and later reports failure. | Apply the fallback policy once, after authenticating and deduplicating the report. |
| S004 | SMS is excluded from the policy. | Never send an SMS, including after other providers fail. |
| S005 | The application reorders the providers. | Attempt them in the configured order. |
| S006 | Every provider fails or is ineligible. | Stop automatic delivery. A previously sent code remains verifiable before its original expiry and within its guess limits under D044. |
| S007 | The user asks to resend. | Resend through the current provider with unchanged code, expiry, and guess count, subject to the default thirty-second cooldown and accepted challenge and recipient send budgets. |
| S008 | The user asks to try the next delivery option. | Use the next configured provider after the default thirty-second cooldown. Optional manual selection is accepted separately under D035. |
| S009 | The user submits an incorrect code. | Consume an attempt atomically and apply challenge and recipient limits. |
| S010 | The user submits an expired or previously used code. | Reject it without reopening the challenge. |
| S011 | Two requests submit the correct code concurrently. | Only one can perform the successful verification transition. Define idempotent replay separately. |
| S012 | The application repeats a create request after a network timeout. | An idempotency key returns the existing operation. It does not trigger a new delivery. |
| S013 | A provider request times out after it may have been accepted. | Record an uncertain outcome. Do not assume failure, automatically resend, or advance. Allow an explicit user action within the existing limits. |
| S014 | A provider definitively rejects invalid credentials or reports depleted balance. | Report an operator error and advance to the next eligible provider without retrying that delivery record under D055. |
| S015 | A provider definitively throttles a request. | Advance to the next eligible provider without an automatic retry under D069. Respect provider restrictions for any later explicit send. |
| S016 | A worker crashes before or after a provider call. | Recover durable work without assuming that an unrecorded response means no message was sent. |
| S017 | Provider callbacks are duplicated, delayed, or arrive out of order. | Keep state consistent. Do not send duplicate fallback messages or reopen terminal challenges. |
| S018 | The user verifies while a fallback is being scheduled. | Cancel pending work. Define the unavoidable race with a message already being sent. |
| S019 | The user starts multiple login flows for the same phone number. | Independent challenges coexist under D033. Repeated requests with the same idempotency key reuse the existing challenge. Aggregate recipient limits still apply. |
| S020 | A login code is submitted for a different purpose or context. | Reject it. Bind verification to the original challenge context. Separate applications use separate router instances. |
| S021 | A developer adds a private SMS provider. | Register a plugin, supply its configuration, and reference its instance in a policy. No core changes. |
| S022 | An operator updates a policy while challenges are active. | Active challenges retain their snapshot. Incompatible provider changes require draining old work under D049. A startup disable blocks the affected provider without substituting another account. |
| S023 | A recipient or client exceeds rate limits. | Reject or delay work before incurring another provider charge. Define externally visible errors. |
| S024 | A provider accepts a message but never reports delivery. | Wait for an explicit user action after the cooldown. Lack of a callback is not proof of failure and never enables timed fallback. |
| S025 | The service restarts after a challenge expires. | Skip expired work and clean up secrets according to retention policy. |
| S026 | The database or rate limiter is unavailable. | Define fail-closed behavior for sends and verification. Never silently bypass limits. |
| S027 | An attacker forges a callback or supplies a challenge ID without the required authorization context. | Reject the request before state changes. |
| S028 | A provider lacks delivery receipts, polling, or idempotent sends. | Declare the missing capabilities. Reject policies that require unsupported guarantees. |
| S029 | An application enables manual choice and the user selects SMS while Telegram delivery is uncertain. | Validate that SMS is allowed and the cooldown has elapsed, then schedule the chosen option within the same challenge and shared budgets under D035. |
| S030 | A manual-selection request targets a disabled or unconfigured provider. | Reject the choice without sending or changing the active route under D035. |
| S031 | Two SMS providers are configured and the user selects SMS without naming a vendor. | Resolve the first eligible SMS instance in policy order. The backend may explicitly target an allowed instance under D035. |
| S032 | A custom routing selector chooses providers for a challenge. | Validate and persist the selected order at creation. Later sends and worker recovery use the snapshot and preserve verification and abuse checks under D042. |
| S033 | An operator observes a verification outcome. | Provide redacted structured diagnostics under D074. Logs and metrics cannot change verification or authorize a business action; public lifecycle hooks are outside v1. |
| S034 | A requested locale lacks a compatible provider template. | Resolve the provider template using the explicit global fallback order under D072. Reject creation before dispatch if any selected provider requiring templates has no match. Reject startup configuration lacking default or fallback coverage for any policy-eligible provider. |
| S035 | An initial request selects WhatsApp from a Telegram, WhatsApp, SMS route. | If manual selection is enabled, start with WhatsApp and fall back to SMS on confirmed failure. Do not automatically wrap back to Telegram under D035. |
| S036 | A request selects a channel while manual selection is disabled. | Reject the override without sending. |
| S037 | The challenge exhausts its send budget and a delayed message arrives. | Its code can verify before the unchanged expiry and guess limit under D044. No additional send budget is granted. |
| S038 | The backend cancels an active challenge. | Block verification and pending sends, remove code secrets, and preserve redacted history under D040 and D045. |
| S039 | An already dispatched provider request completes after cancellation. | Record the permitted redacted delivery outcome without reopening verification or scheduling fallback. Cancellation cannot recall the message. |
| S040 | A verification request waits for a lock across the expiry deadline. | Reject it using a fresh database clock after acquiring the lock. UTC formatting alone does not establish validity. |
| S041 | A recent backup restores a consumed challenge as active. | Cancel restored active challenges and suppress pending sends before reopening traffic. Reconcile lost quota usage or wait out its accounting windows. |
| S042 | A queued send starts late. | Dispatch extends the user cooldown from the actual reservation time. Neither queue delay nor resend extends challenge expiry. |
| S043 | A late receipt confirms delivery while automatic fallback is pending. | Suppress pending automatic work but preserve an explicit user-requested delivery under D061. A duplicate receipt does not suppress a later user action again. |
| S044 | A verification operation is replayed after the challenge ends. | Delete its code fingerprint, match its original operation key and non-code fields, and return the old result without consuming another guess. A new key cannot verify a terminal challenge. |
| S045 | A provider's minimum delivery window exceeds the remaining lifetime. | Skip it without a send reservation. Never extend verification to accommodate the provider. |
| S046 | Many recipients collectively exhaust a deployment send cap. | Block further dispatch across all processes until every applicable limit permits it. Preserve reservations for failed and uncertain sends. |
| S047 | A user-requested resend is followed by an uncertain response. | Preserve uncertainty without an automatic resend or fallback. The new delivery record uses the same code and expiry and consumes the shared send budget. |
| S048 | A duplicate delivery receipt arrives after a new user action. | Keep the new action's automatic-routing state unchanged; known delivery evidence must not be applied twice. |
| S049 | A provider reports delivery, but the user cannot find the code. | Permit resend through the current eligible provider after cooldown and within expiry and shared limits. |
| S050 | A late failure arrives for an attempt superseded by a user resend or selection. | Record the outcome without advancing the new action's route. |
| S051 | A provider supports idempotent sends, but the send outcome is uncertain. | Do not automatically repeat the send. Reconciliation may resolve it without another send; otherwise wait for an explicit user action. |
| S052 | Configuration enables automatic provider-send retries or timed fallback. | Reject the unsupported configuration at service startup. |
| S053 | A worker recovers a job before or after its dispatch gate. | Resume work that has not crossed the gate if still eligible. Preserve or reconcile an unresolved dispatch without another send invocation. |
| S054 | Uzbek is requested with global fallbacks Russian then English. | Resolve Uzbek, Russian, then English separately for each provider and save the first compatible template. Different providers may use different languages. |
| S055 | A request omits its locale or repeats a locale already in the fallback list. | Use the global default when omitted and remove duplicate candidates without changing their order. |
| S056 | A resend or manual selection occurs after locale resolution. | Reuse that provider's saved locale and template settings with the original code and expiry. |
| S057 | A provider is unreachable during service startup. | Start when local configuration is valid and required local infrastructure checks pass. Optional live diagnostics report the provider failure separately. |
| S058 | A custom selector rejects a destination. | Return a safe delivery-unavailable error before creating a challenge, reserving a send, or queueing delivery. |
| S059 | A user resends near expiry. | Keep the original `expiresAt`; default messages make no new lifetime claim. `availableAt` and `Retry-After` never extend validity. |
| S060 | A job is recovered after its delivery record reserved dispatch. | Preserve the reservation and record; reconcile uncertainty without a second send invocation. |
| S061 | A selector returns a route excluding SMS, and the caller explicitly selects SMS. | Reject the choice without sending. An initial rejected choice creates no challenge or job; later rejection leaves the saved route unchanged. |
| S062 | A selector throws or exceeds its execution deadline. | Fail creation without a challenge or delivery job. Do not substitute the configured default route. |
| S063 | A selector attempts to override expiry, limits, cooldown, or other policy settings. | Reject the invalid selector result before creation. Its contract allows only an ordered permitted route or rejection. |
| S064 | Concurrent requests run a selector before creation commits. | Permit repeated side-effect-free selection, but commit only one challenge and saved route for the same idempotent operation. Later actions reuse that route. |
| S065 | A selector exceeds its configured timeout, which defaults to two seconds. | Fail creation without a challenge or delivery job. The deadline covers all selector work, including external reads. Discard a late result; a caller may retry with the same idempotency key. |
| S066 | An application mutation omits its idempotency key. | Reject before state changes. This covers create, verify, resend, next-provider, explicit selection, and cancellation; status reads require no key. |
| S067 | An incorrect-code response is lost and the backend retries with the same operation key. | Replay the saved result without consuming another guess. A new code submission is a new action and uses a new key. |
| S068 | A caller repeats a delivery or cancellation operation with its original key. | Return the saved result without another send, quota reservation, or state transition. A new resend action uses a new key. |
| S069 | A provider is slow to respond after challenge creation or a user delivery action. | Return once the operation and queued work commit, without waiting for the provider. The worker records the later outcome for status reads. |
| S070 | The transaction saving a challenge or user delivery action and its queue job fails. | Do not return successful queued-work acceptance or leave a partial operation. No provider call runs as part of the failed request transaction. |
| S071 | Verification succeeds for the original purpose and context. | Return the D083 JSON result with stored binding, router-generated identifiers, and database verification time. The application completes its bound action once; the router issues no JWT or login token. |
| S072 | The backend submits a different purpose or context during verification. | Reject the mismatch before code comparison. Do not echo unchecked binding fields into a successful result. |
| S073 | The backend replays the successful verification operation. | Return the same verification ID, challenge ID, purpose, context, and original timestamp. This does not authorize another business action. |
| S074 | An application needs a later delivery update. | Read the authenticated challenge-status endpoint. Incoming provider callbacks may update stored status, but the router does not push notifications to the application in v1. |
| S075 | The user submits a code without the application polling delivery status. | Process verification directly and return its result or domain error in the HTTP response. Delivery confirmation is not a verification prerequisite. |
| S076 | The operator rotates the application API key with old/new overlap. | Both keys have the same permissions during transition. Requests using the new key preserve existing challenges, quotas, and idempotency results. |
| S077 | A backend uses the old API key after removal from all API processes. | Reject authentication before challenge access or mutation. Incoming provider callbacks continue using their independent authentication contract. |
| S078 | A caller reuses a create or delivery operation key with changed validated input. | Return `409 idempotency_conflict` without another challenge, send, or state transition. New intended actions require new keys. |
| S079 | A caller changes the code when replaying verification while its challenge remains active. | Return `409 idempotency_conflict` without consuming another guess. After terminal state, use the accepted replay exception: match the original key and non-code fields and return the saved result without code comparison. |
| S080 | Identical requests with the same operation key arrive concurrently. | Allow only one committed operation. A competing request waits within the configured bound and returns the completed matching result when available. |
| S081 | The bounded wait for an in-progress operation expires. | Return `409 request_in_progress` without duplicate side effects. The caller retries with the same key and input; the response does not imply that the original operation failed. |
| S082 | A cooldown or rate limit rejects an operation without changing state. | Do not save a completed idempotency result for that rejection. The caller may retry with the same key and input when eligible. |
| S083 | An incorrect-code submission commits a consumed guess or locks the challenge. | Save its failure result atomically with the mutation. Replaying it cannot consume another guess or repeat the transition. |
| S084 | Authentication, input validation, or a rolled-back transaction prevents an operation. | Do not save a completed idempotency result for that failed operation. A lost commit response requires lookup or replay because it does not establish rollback. |
| S085 | A caller reuses an operation key after its required retention has ended and cleanup removed it. | Treat it as a new operation under normal validation and limits. Creation may create another challenge; terminal challenges cannot be revived. |
| S086 | A result is still stored after twenty-four hours, or its associated work remains active. | Continue replaying the retained result. Do not remove it merely because the minimum elapsed while related work is active. |
| S087 | A provider accepts a send but no authenticated delivery report arrives. | Preserve the unconfirmed delivery state. Do not poll the provider or automatically advance; verification and eligible explicit user actions remain available. |
| S088 | A backend reads challenge status or a worker recovers unresolved delivery. | Use stored state and received authenticated evidence. Do not trigger a provider status lookup under D090. |
| S089 | An API, worker, or combined process starts against an empty database or an older supported schema. | Run router and pg-boss migrations automatically. Accept application traffic and process router jobs only after both succeed. Migration failure or an unsupported schema fails startup without application side effects. |
| S090 | Multiple instances start and attempt migrations, or a process dies between the two migration systems. | Coordinate schema changes and resume completed/pending steps safely on restart. No application work begins until both schemas are ready. Stop old versions before incompatible upgrades; migration locks do not guarantee version compatibility. |
| S091 | A built-in or custom adapter omits its default send timeout or supplies an invalid value. | Reject startup, even if an instance supplies an override. Apply the same contract to all adapters. |
| S092 | An operator overrides an adapter's default timeout for one instance. | Validate the override and have the core enforce it across the complete send operation, bounded by remaining challenge lifetime. Other instances keep their own configured values. |
| S093 | A send exceeds its effective timeout without definitive provider evidence. | Persist uncertainty and retain its send reservation. Do not resend or advance automatically; late evidence follows normal merge rules. |
| S094 | The API or worker receives a graceful shutdown request. | Stop accepting new application requests and claiming jobs, allow bounded completion, persist outcomes where possible, and close resources. Do not cancel challenges or extend expiry. |
| S095 | A provider call remains unresolved when the shutdown grace period ends or the process dies. | Preserve the committed dispatch reservation and uncertainty. Recovery cannot repeat the send; work that never crossed the dispatch gate remains eligible for normal recovery. |
| S096 | The process is responsive but its database is unavailable or schemas are incompatible. | Liveness may pass while readiness fails. Do not accept work through unavailable persistence or bypass limits. |
| S097 | A messaging provider is unavailable while the router's own dependencies and role resources are ready. | Keep readiness independent of the provider outage and report provider failures in diagnostics. Health checks never send messages or query provider health. |
| S098 | A worker loop has not started, has stopped, or its process is shutting down. | Report the worker role unready. Combined-role readiness requires both API and worker conditions. |
| S099 | An operator supplies a TypeScript configuration entry file organized with imports. | Load and validate that entry at startup, with secrets supplied externally. No automatic merging of separate configuration entries is provided. |
| S100 | An operator edits configuration while the process is running. | Keep the loaded startup configuration until restart or replacement. Follow drain and rotation rules; no live reload occurs. |
| S101 | A backend creates, reads, verifies, requests delivery, or cancels a challenge. | Use the five application endpoint methods and paths under D096. Resend, next-provider, and selection are tagged alternatives on the shared deliveries endpoint. |
| S102 | An application operation completes or fails. | Return the D097 HTTP status and stable domain error code from the API contract. Later asynchronous provider failure changes delivery status, not the committed queueing response. |
| S103 | An application operation returns an expected error. | Use the D098 envelope with a stable code, safe message, request ID, and retry time only when known. Preserve distinct typed internal failures under D099 without leaking private data. |
| S104 | An unexpected programming defect interrupts an HTTP operation. | Return `500 internal_error` with a generic message and request ID when possible; keep redacted details in logs. Do not manufacture an incorrect-code result or confirmed delivery failure. Persisted-state recovery and idempotency still govern uncertain outcomes. |
| S105 | A caller supplies an ambiguous local phone number without international prefix and country code. | Reject it without inferring a country or queueing delivery under D101. |
| S106 | A valid international phone number is used for routing and recipient limits. | Normalize it to E.164 before routing and quota lookup. Adapter wire-format changes do not create a new recipient identity; validation does not prove reachability or ownership. |
| S107 | A backend creates a challenge. | Require recipient, purpose, contextId, and policyId under D102. Accept optional locale, deliveryChoice, and bounded routingContext. Enforce purpose-policy permission; generate the code, challenge ID, and expiry in the router. |
| S108 | A release requires an incompatible database or runtime-contract change. | Permit planned maintenance under D103. Follow the documented drain, stop, migration, and restart sequence without extending challenge expiry. |
| S109 | An operator wants a rolling upgrade. | Permit it only for releases with established schema, job, plugin, and configuration compatibility. V1 does not promise uninterrupted upgrades for incompatible changes. |
