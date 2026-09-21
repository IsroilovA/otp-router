# Providers and routing selectors

Extensions are trusted server code installed with the deployment. Import supported contracts from `@otp-router/engine/providers` and `@otp-router/engine/config`. Server configurations use `@otp-router/server/config`. Engine consumers can use the [public operations](engine.md); SQL helpers and internal records stay private.

Use the [custom adapter example](../examples/custom-adapter/README.md) to check package boundaries. Exact signatures live in the exported TypeScript contracts.

## Provider instances

A definition describes an integration. An instance binds it to credentials, an account, sender settings, templates, and an optional timeout override. Instances expose ready Effect operations with no unresolved application-service requirements.

Validate local configuration and templates before startup. Keep account identity stable for an instance ID. Use a new ID when changing accounts; do not reuse one while callback history remains. Change its non-secret settings fingerprint for incompatible delivery-setting changes and follow the [drain procedure](operations.md#configuration-changes).

A provider receives a normalized phone number, unchanged router code, absolute expiry, remaining delivery budget, resolved template, and opaque correlation identifiers. It must not log these inputs, choose a fallback provider, or verify the challenge.

## Send outcomes

Success means acceptance, not delivery. Return a provider request ID when available. Do not return raw responses.

Expected failures carry a category, acceptance certainty, a normalized diagnostic code, and an optional retry time. Declare safe diagnostic codes in `diagnosticCodes`; undeclared text is replaced with `unclassified` before persistence. Keep defects and interruption distinct from expected failures.

Definitive rejection can advance routing. Unknown acceptance cannot. A generic server error or timeout does not establish rejection. Disable transport retries even when the provider supports idempotency. A user-requested resend is a new delivery, not a retry of an earlier provider request.

Declare a positive finite default send timeout. The instance timeout and provider minimum delivery window must fit the policy lifetime. The core bounds invocation using the remaining budget; adapters must honor it and connect interruption to transport cancellation.

## Callbacks

Authenticate bounded raw bytes and request metadata before decoding events. Return typed authentication or format failures for invalid input. Derive stable deduplication keys from authenticated event identity, never receipt time.

Correlate through an opaque delivery reference or a provider-issued request ID. The core retains early unmatched reports for reconciliation. Normalize status and allowlisted diagnostics only. Handshake responses retain the adapter's status, content type, and raw bytes.

Callbacks cannot authorize a resend or verify a challenge. Automatic polling, paid preflight, and remote cancellation are outside the extension contract.

## Templates and locales

A deployment defines a default locale and ordered fallback locales. Resolve the requested locale, or the default when omitted, followed by explicit fallbacks. Remove duplicates and do not invent language mappings.

Resolve every provider in the selected route before creation commits. Missing required template coverage rejects creation. Save non-secret resolved settings so resend and fallback reuse them. Providers without configurable templates are exempt.

Adapters own template validation and wire formatting. Default messages contain the code without a relative-lifetime claim, since resends preserve the original expiry. Remote template changes require the same care as local configuration changes.

## Routing selectors

A selector receives the normalized recipient, purpose, locale, and bounded routing context. It returns a nonempty ordered subset of policy-permitted provider IDs, or rejects creation. It cannot change expiry, quotas, or manual-selection permissions.

Selectors run outside database transactions and may execute more than once for competing requests. They must not send messages or perform paid or business actions. Bound their complete execution with one timeout. Failure, timeout, or an invalid route rejects creation without substituting a default route.

Completed creation replays bypass the selector. Later delivery actions use the saved route and current eligibility checks.

Provider send input identifies `operationId` and `attemptId`. These replace challenge identity and the old ambiguous delivery ID. An adapter handles managed and external operations identically, preserves leading-zero codes and disables send retries.
