# Routing and delivery

A policy defines an ordered list of provider instances. A creation-time selector may narrow and reorder that list, but cannot add providers or change security limits. The saved route controls all later actions.

## Automatic progression

Confirmed rejection or final delivery failure advances to the next eligible provider. Automatic routing never wraps around. Invalid recipient input common to all providers stops delivery.

Unknown acceptance, timeouts, programming defects, and interruption do not authorize fallback or another send. There are no timed fallbacks, automatic provider-send retries, or status polling. Disable retries in transports and provider SDKs as well.

Provider eligibility includes the saved configuration identity, emergency disables, provider restrictions, remaining lifetime, and send budgets. Creation, next, and automatic fallback skip providers whose individual budgets or restrictions block sending; shared budget exhaustion blocks every provider. A generic HTTP error does not establish whether the provider accepted a request.

## User actions

`resend` targets the current provider. `next` starts after its position. `select` chooses an allowed channel or instance when manual selection is enabled. A channel choice uses policy order among eligible instances with available quota.

Every accepted user action creates a new provider attempt and routing revision. It supersedes conflicting pending work. An in-flight message may still arrive. Reuse the original code, expiry, and guess count across every action.

An explicit choice can revisit a previously failed provider if it is eligible again. If that choice fails definitively, fallback continues after its position without wrapping. Resend remains available after accepted, uncertain, or delivered outcomes while the challenge and budgets permit it.

## Cooldown and deadline

Creation and accepted user actions start the cooldown. Dispatch extends it to at least dispatch time plus cooldown. Automatic fallback bypasses the user cooldown. Rejections and replays do not change it.

Expiry is fixed at creation. Queue delay and time spent inside the dispatch transaction consume the lifetime. Derive the remaining budget from database time and subtract elapsed monotonic time before invoking an adapter. The provider's request timeout and minimum delivery window must fit. Skip transmission if the budget expires after reservation; retain the committed reservation conservatively.

Provider TTL limits delivery attempts, not code validity. Some providers can deliver after expiry; verification still rejects the expired code.

## State and evidence

Verification progresses from active to verified, locked, expired, or cancelled. These terminal states never reopen. Treat an overdue active row as expired even before cleanup runs. Delivery exhaustion leaves verification available until the original deadline and guess limits.

Each provider attempt moves from pending through dispatch to an outcome. Recovery turns unresolved dispatching work uncertain and never sends it again. Explicit resend creates a different record.

Callbacks and send responses share outcome rules. Late acceptance cannot overwrite delivery or confirmed final failure. Authenticated delivery evidence can resolve an earlier uncertain or failed outcome. A stale failure cannot advance a newer route.

New delivery evidence stops pending automatic fallback, but does not cancel an explicit user send. Duplicate delivery evidence must not suppress a later action. Local cancellation cannot recall a message already in flight.

The managed public projection is `queued`, `sending`, `accepted`, `uncertain`, `verified`, or `failed`; internal verification and delivery states remain independent. Accepted/delivered records are acceptance evidence until a confirmed final failure invalidates that record. A failed or uncertain resend cannot erase another accepted record. Public provider/channel identify confirmed acceptance, never route selection. Once initial processing starts, fallback stays `sending`.

Every meaningful resulting snapshot is published once per committed transition with an increasing revision. Duplicate evidence and internal bookkeeping produce no events. Late delivery evidence can change active challenges but cannot alter a terminal public snapshot.

Action forecasts and absolute retry times are saved with the snapshot; time passing creates no event. Clients can reconsider a timed denial at its deadline, before expiry. Revalidate submitted actions because forecasts neither reserve capacity nor guarantee future eligibility.

## Independent operations

The same dispatch, eligibility, evidence and fallback machinery serves prepared external-code operations and managed challenges. A prepared operation cannot send until attachment. External absolute deadlines allow the configured delivery lifetime (900 seconds by default); managed generation retains its separate 60–600 second limit. Attachment and dispatch both check the fixed deadline, and every saved provider must accept the code format and length.

New operations and accepted user sends share recipient admission: one per 30 seconds, alongside rolling creation/send budgets. Dispatch extends that recipient cooldown. Automatic confirmed-failure fallback never waits for it. Recipient/provider/deployment send reservations are shared across capabilities and retain uncertain or failed dispatched attempts.

External lifecycle is prepared → active → closed/expired; it never reopens. Its public state is prepared, queued, sending, accepted, uncertain, failed, closed or expired. Failure/exhaustion of routing alone does not close the operation. Delivery snapshots contain submit/close/send forecasts and no verification claim. Closing erases recoverable secrets and suppresses pending work, but cannot recall a reserved or transmitted message.
