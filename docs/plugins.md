# Provider and selector contracts

Extensions are trusted deployment code. Supported [provider contracts](../packages/engine/src/providers/contract.ts) and [selector types](../packages/engine/src/config/config.ts) define interfaces. Build adapters with the exported `defineProvider` helper, which validates separate identity, send-secret, callback-secret, execution, and template schemas. The [custom adapter example](../examples/custom-adapter/README.md) demonstrates this through package exports.

## Providers

- Validate local settings and templates before accepting traffic. Accounts identify upstream identities; instances identify routable configurations under an account. Declare adapter and configuration-schema versions in deployment code.
- Provider Layers are constructed outside database transactions and remain scoped through template resolution or the committed send. Constructors must never send messages; only `send` invokes delivery. Callbacks are constructed separately through `makeCallback`, without send credentials. Callback factories and callback authentication/normalization must use local computation without remote I/O.
- Preserve the supplied code, recipient, and deadline. Never verify challenges, choose fallback providers, or log send inputs.
- Success means acceptance, not delivery. Return `ProviderRejected` with a reason only when provider evidence proves the send was not accepted; return `ProviderUncertain` when acceptance remains unknown. Use `unspecified` when rejection is established but its cause cannot be classified. Declare safe diagnostic codes and keep defects and interruption distinct. Raw payloads and undeclared diagnostic text must not escape the adapter.
- A timeout or generic server error cannot establish rejection. Disable transport retries, including when the provider supports idempotency. Honor the remaining delivery budget and propagate interruption to transport cancellation.
- Authenticate raw callbacks before decoding and validate upstream account/sender metadata where available; derive deduplication identity from authenticated evidence, not receipt time. Each normalized event uses a typed correlation reference: the router's attempt ID when the provider echoes it, or the provider request ID otherwise. An event correlated by attempt may also carry the provider request ID, allowing later reports that contain only that ID to resolve even if the send response was lost. Early reports must remain reconcilable.
- Callbacks report evidence; the router decides whether that evidence permits [fallback](routing.md). They never verify a code. Automatic polling, paid preflight, and remote cancellation are outside the contract.

## Templates and locales

Use the requested locale, or the policy default when omitted, followed by explicit fallback locales. Remove duplicates without inventing language mappings.

Validate template coverage for every provider in the selected route before accepting creation. Save the chosen non-secret settings for later delivery actions. Providers without configurable templates are exempt.

Messages must not imply a fresh lifetime on resend. Remote template changes must preserve retained revisions; otherwise invalidate affected revisions explicitly. See [provider setup](provider-setup.md) for account constraints.

## Routing selectors

Return a nonempty ordered subset of policy-permitted providers or reject creation. Never change expiry, quota, or manual-selection permissions.

Register selectors by stable ID and version in deployment configuration; policies reference those IDs. Selectors may execute more than once for competing requests. They must not send messages or perform paid or business actions. Bound their complete execution; failure, timeout, or an invalid result rejects creation without substituting a default route.

Completed creation replays bypass selection. Later actions use the saved route and current eligibility rules. Providers serve managed and external operations identically.
