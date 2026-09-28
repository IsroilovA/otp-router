# Routing and delivery

A policy defines an ordered list of provider instances. A creation-time selector may narrow and reorder that list, but cannot add providers or change security limits. The saved route controls all later actions.

## Automatic progression

Confirmed rejection or final delivery failure advances to the next eligible provider. Automatic routing never wraps around. Invalid recipient input common to all providers stops delivery.

Unknown acceptance, timeouts, programming defects, and interruption do not authorize fallback or another send. There are no timed fallbacks, automatic provider-send retries, or status polling. Disable retries in transports and provider SDKs as well.

Provider eligibility includes the saved configuration identity, emergency disables, provider restrictions, remaining lifetime, and send budgets. Creation, next, and automatic fallback skip providers whose individual budgets or restrictions block sending; shared budget exhaustion blocks every provider. A generic HTTP error does not establish whether the provider accepted a request.

## User actions

`resend` targets the current provider. `next` starts after its position. `select` chooses an allowed channel or instance when manual selection is enabled. A channel choice uses policy order among eligible instances with available quota.

Every accepted user action creates a new provider attempt and routing revision, subject to its own [send authorization](authorization.md). It supersedes conflicting pending work. An in-flight message may still arrive. Reuse the original code, expiry, and guess count across every action.

An explicit choice can revisit a previously failed provider if it is eligible again. If that choice fails definitively, fallback continues after its position without wrapping. Resend remains available after accepted, uncertain, or delivered outcomes while the challenge and budgets permit it.

## Cooldown and deadline

Creation and accepted user actions start the cooldown. Dispatch extends it to at least dispatch time plus cooldown. Automatic fallback bypasses the user cooldown. Rejections and replays do not change it.

Expiry is fixed at creation. Queue delay and dispatch preparation consume the lifetime. Evaluate the remaining budget immediately before invoking a provider. The provider's request timeout and minimum delivery window must fit. Skip transmission if the budget expires after reservation; retain the committed reservation conservatively.

Provider TTL limits delivery attempts, not code validity. Some providers can deliver after expiry; verification still rejects the expired code.

## State and evidence

Verification progresses from active to verified, locked, expired, or cancelled. These terminal states never reopen. Treat an overdue active row as expired even before cleanup runs. Delivery exhaustion leaves verification available until the original deadline and guess limits.

Recovery treats unresolved dispatched work as uncertain and never sends it again. Explicit resend is a new attempt.

Callbacks and send responses share these evidence rules. Evidence updates an existing invocation; only an explicit command creates a user send.

| Existing evidence | Incoming evidence | Result and routing effect |
| --- | --- | --- |
| Pending, dispatching, or uncertain | Acceptance | Record acceptance; suppress pending automatic fallback. |
| Any unsuppressed attempt | First authenticated delivery | Record delivery; stop automatic progression and suppress pending automatic fallback. |
| Accepted | Uncertain | Preserve acceptance. |
| Failed | Acceptance, uncertainty, or repeated failure | Preserve final failure and its existing failure diagnostics; no second fallback. |
| Delivered or suppressed | Any | Preserve state; duplicates cannot suppress a later explicit action. |
| Current active attempt | First confirmed rejection or final failure | Consider the next eligible provider under current budgets, unless delivery is stopped. |
| Older attempt or routing revision | Failure | Record evidence without advancing the current route. |
| Terminal operation | Any | Never reopen it or change its terminal public snapshot. |

Authenticated delivery can resolve an earlier uncertain or failed attempt. A confirmed invalid-recipient rejection separately sets a permanent stop for the operation: neither later delivery evidence nor an explicit command clears it. Verification remains available under its original limits. Repeated failure reports cannot erase that stop.

New delivery evidence stops pending automatic fallback, but does not cancel an explicit user send. Duplicate delivery evidence must not suppress a later action. Local cancellation cannot recall a message already in flight.

A failed or uncertain resend cannot erase another attempt's still-valid acceptance. Public provider/channel identify confirmed acceptance, never route selection. See [public states and action forecasts](api.md#status-and-action-forecasts).

Late delivery evidence can change active challenges but cannot alter a terminal public snapshot. It remains independently observable through [attempt history](history.md). [Public events](webhooks.md) describe committed changes; time passing alone creates no event.

## Independent operations

The same eligibility, evidence, quota, and fallback rules apply to external-code operations and managed challenges. A prepared operation cannot send until attachment. Policy settings bound external deadlines and managed lifetimes; see [configuration](configuration.md#policies). Attachment and dispatch both check the fixed deadline, and every saved provider must accept the code format and length.

Within a project, new operations and accepted user sends share recipient admission: one per 30 seconds, alongside rolling creation/send budgets. Dispatch extends that recipient cooldown. Automatic confirmed-failure fallback never waits for it. Recipient/project/provider/deployment send reservations are shared across capabilities under the [configured limit scopes](projects.md#limit-scopes) and retain uncertain or failed dispatched attempts.

Routing exhaustion alone does not close an external operation. Its caller ends the flow through the [external lifecycle](engine.md#external-delivery).
