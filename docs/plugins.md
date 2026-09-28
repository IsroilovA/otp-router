# Provider and selector contracts

Extensions are trusted deployment code. Supported [provider contracts](../packages/engine/src/providers/contract.ts) and [selector types](../packages/engine/src/config/config.ts) define interfaces; the [custom adapter example](../examples/custom-adapter/README.md) demonstrates consumption through package exports.

## Providers

- Validate local settings and templates before accepting traffic. Instance IDs identify accounts; follow [configuration changes](operations.md#configuration-changes) when changing identity or incompatible settings.
- Preserve the supplied code, recipient, and deadline. Never verify challenges, choose fallback providers, or log send inputs.
- Success means acceptance, not delivery. Normalize failures with acceptance certainty and declared safe diagnostics; keep defects and interruption distinct. Raw payloads and undeclared diagnostic text must not escape the adapter.
- A timeout or generic server error cannot establish rejection. Disable transport retries, including when the provider supports idempotency. Honor the remaining delivery budget and propagate interruption to transport cancellation.
- Authenticate raw callbacks before decoding; derive deduplication identity from authenticated evidence, not receipt time. Correlate using opaque delivery references or provider request IDs. Early reports must remain reconcilable.
- Callbacks cannot authorize a send or verify a code. Automatic polling, paid preflight, and remote cancellation are outside the contract.

## Templates and locales

Use the requested locale, or the deployment default when omitted, followed by explicit fallback locales. Remove duplicates without inventing language mappings.

Validate template coverage for every provider in the selected route before accepting creation. Save the chosen non-secret settings for later delivery actions. Providers without configurable templates are exempt.

Messages must not imply a fresh lifetime on resend. Remote template changes require the same drain considerations as local settings. See [provider setup](provider-setup.md) for account constraints.

## Routing selectors

Return a nonempty ordered subset of policy-permitted providers or reject creation. Never change expiry, quota, or manual-selection permissions.

Selectors may execute more than once for competing requests. They must not send messages or perform paid or business actions. Bound their complete execution; failure, timeout, or an invalid result rejects creation without substituting a default route.

Completed creation replays bypass selection. Later actions use the saved route and current eligibility rules. Providers serve managed and external operations identically.
