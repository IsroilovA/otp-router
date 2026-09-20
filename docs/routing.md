# Routing and delivery

Status: implementation contract.

## Accepted defaults

Applications configure an ordered list of provider instances. The router uses only those instances. A channel excluded from the policy is never used. Built-in and custom providers follow the same rules.

| Event | Default behavior |
| --- | --- |
| A provider confirms rejection or final delivery failure. | Automatically advance to the next configured eligible provider. |
| A provider accepted the message, but delivery remains uncertain. | Wait for an explicit user action. After cooldown, the user may request resend or another permitted provider. |
| The user requests resend or selects another permitted provider. | Schedule the explicit action within cooldowns, expiry, provider restrictions, and shared limits. |

Under D068-D069, v1 has no timed fallback and no automatic provider-send retries, even when a provider supports idempotency. Reject configuration that enables either behavior. D057 defines cooldown timing. Provider availability checks are not assumed free.

The adopting application's backend submits user actions through the HTTP API. The [API contract](api.md) defines endpoints under the accepted backend-only access model.

## Custom routing and provider eligibility

A [creation-time selector](plugins.md#custom-routing-selection) chooses an ordered subset of permitted providers or rejects the destination. Validate initial manual choices after selection; later choices stay within the saved route and current eligibility. Selector errors never substitute a default route.

Destination restrictions may live in the backend, selector, or adapter constraints. V1 has no regional-rule engine, country-policy subsystem, provider health scoring, circuit breaker, or health-based reordering. Operator disables and diagnostics remain supported; process health checks are separate.

## Accepted user controls

Provide an action to resend through the current provider and an action to try the next provider in the configured order. Both obey the configured cooldown and limits. They reuse the challenge's code without extending its expiry or resetting failed guesses. Resend remains supported after accepted, uncertain, or confirmed delivery while the challenge and current provider remain eligible. A user-requested resend creates a new delivery record and a new provider idempotency key where supported; it is not a replay of the earlier send. Once automatic fallback has advanced, resend targets the new current provider.

## Cooldown and deadlines

The router fixes `expiresAt` at creation under D059. Resend and fallback never change it. Use the database clock rules in the [data model](data-model.md#ownership-and-identifiers).

Under D057, initial queueing and each accepted user delivery action set `nextUserSendAt` to the current database time plus the configured cooldown. Each provider dispatch extends it to the greater of its current value and dispatch time plus cooldown. Automatic fallback bypasses this user cooldown but still extends it when dispatched. Rejected actions and idempotent replays do not change it.

Check cooldown and advance the routing revision in the same transaction, so competing user requests cannot both schedule work. `resend` targets the current delivery record's provider; `next` starts after its route position; `select` resolves the requested permitted option. A still-pending send may be superseded after cooldown, but an in-flight request cannot be recalled.

Adapters receive the unchanged expiry and remaining delivery budget. Where a provider supports delivery TTL, choose a value within its documented bounds and the remaining budget. Account for request timeout and rounding when calculating that budget. Skip the provider without consuming a send when its minimum cannot fit. A provider without an enforceable delivery TTL may deliver late; the router still rejects the code at its deadline. Do not claim that provider TTL guarantees arrival before expiry.

Under D092, the core enforces each provider instance's configured send timeout, falling back to the adapter's required default, and bounds execution by the remaining challenge lifetime. Timeout alone leaves delivery uncertain and never authorizes an automatic resend or fallback. See [send timeout](plugins.md#send-timeout).

## Failure handling

Determine acceptance certainty before applying the outcome below.

| Outcome | Routing action |
| --- | --- |
| Recipient unavailable on this channel, or confirmed final delivery failure | Advance to the next eligible instance. |
| Invalid provider credentials or depleted balance, definitively rejected | Record an operator error and advance without retrying this delivery record. |
| Provider-specific sender or template rejection | Record an operator error and advance without retrying this delivery record. |
| Definitive throttling or temporary rejection | Advance to the next eligible instance without retrying this delivery record. Preserve provider restrictions when assessing later explicit sends. |
| Invalid recipient input common to all providers | Stop delivery. Do not repeat invalid input across providers. |
| Unknown acceptance, including an unexplained timeout or server error | Preserve uncertainty and wait for an explicit user action. Do not automatically resend or advance, even with provider idempotency. |
| Programming defect or process interruption | Record the failure or uncertain in-flight outcome. Do not convert it into automatic fallback. |

Each initial send, fallback, or user-requested send consumes a new send reservation. A replay of the same API operation creates no new delivery record or reservation. An uncertain user-requested resend remains uncertain; it does not authorize automatic fallback. Exhausting a challenge or recipient send budget blocks further sends, including fallback. Verification remains available under D044.

## Accepted manual selection

Allow applications to enable manual delivery selection in a named policy. Leave it disabled by default so applications retain the accepted ordered behavior unless they choose otherwise. An optional allowlist can expose only some of the configured delivery options for manual selection.

For example, a policy can automatically start with Telegram while allowing the user to request WhatsApp or SMS after the cooldown. A different policy can expose only Telegram and WhatsApp. Manual selection cannot introduce a provider absent from the active policy.

End users normally choose a channel, such as SMS. The backend resolves that channel to an eligible provider instance in policy order. If two SMS vendors are configured, a generic SMS choice need not expose their names. An authenticated backend request may target a particular configured instance, still within the policy's permitted choices. Custom channel identifiers and configured display labels must work without changes to the core.

Return permitted options and when they can be used as part of the challenge status response. The application renders its own controls. Revalidate every action on the backend because options may become stale. Do not infer or reveal messaging-account membership merely from the list of configured options.

All manual choices use the same code, expiry, failed-guess count, cooldown, and send budgets as other user actions. A choice does not reset recipient-wide limits or override a terminal challenge. It cannot supply arbitrary credentials, destinations, or provider URLs.

A manual choice must supersede conflicting pending routing work atomically. A message already in flight may still arrive, which is one reason for reusing the same code. A job or failure callback belonging to an earlier routing action must not cause another unintended send.

Under D035, selection is available on the initial request and later user actions. Subsequent actions obey the cooldown. If the selected provider fails, continue through the remaining configured order after that instance, without automatic wraparound. Manual selection does not implicitly start concurrent deliveries. Under D063, a previous failure does not permanently remove an option. Revalidate its configuration, local eligibility, cooldown, and budgets for each explicit user selection. Automatic routing still never wraps around.

## Challenge lifecycle

Verification state and delivery state are separate. A challenge has one verification state and a history of delivery attempts. Provider acceptance, delivery reports, and routing exhaustion must not be mistaken for proof that the user supplied the correct code.

| Verification state | Meaning | Allowed transition |
| --- | --- | --- |
| `active` | The challenge may accept a code while its deadline and limits permit. | `verified`, `locked`, `expired`, or `cancelled`. |
| `verified` | One code submission succeeded. | None. An idempotent replay returns the original result without a new transition. |
| `locked` | The challenge reached its incorrect-guess limit. | None. |
| `expired` | The original expiry deadline has passed. | None. |
| `cancelled` | The adopting backend abandoned the challenge under accepted D045. | None. |

Treat an `active` row whose deadline has passed as expired even before cleanup persists the terminal state. Read, verify, user-delivery actions, and worker dispatch all apply this rule using database time. Cleanup delay never extends code validity.

An aggregate recipient limit may temporarily reject an operation while the challenge remains active. This is separate from the per-challenge guess limit, which permanently locks that challenge. A limit rejection must state whether and when another attempt can be made without extending the challenge's deadline.

Under accepted D044, delivery exhaustion is not a terminal verification state. If a message arrives late, its code can still verify before the original expiry and within the original guess limits. Status must distinguish an exhausted route from a locked or expired challenge. An exhausted automatic route may still permit an explicit manual choice if policy and remaining budgets allow it.

## Delivery records

A delivery record identifies one requested dispatch through one provider instance. It records the cause, such as initial delivery, fallback, resend, or manual selection. Each delivery record permits at most one external send invocation. User-requested resend creates a new pending record; its send counts only when dispatch reserves quota. Queue recovery does not grant another invocation to an existing dispatched delivery record.

| Delivery state | Meaning |
| --- | --- |
| `pending` | Durable work exists; the worker has not crossed the dispatch gate. |
| `dispatching` | The worker has committed its eligibility check and send-budget reservation before the provider call. |
| `accepted` | The provider accepted the request; final delivery may still be unknown. |
| `delivered` | Authenticated provider evidence confirms delivery. |
| `failed` | Provider evidence confirms rejection or final delivery failure. |
| `uncertain` | The request may have been accepted, but the router cannot establish its outcome. |
| `suppressed` | The worker skipped the call because eligibility ended or newer routing work superseded it. |

Queue execution status is separate from these records. Completing or retrying a pg-boss job does not itself prove delivery success or failure. On recovery, an unresolved `dispatching` attempt becomes uncertain unless provider evidence resolves it. Do not reset it to `pending` and send blindly.

Keep acceptance certainty and the normalized failure category alongside the delivery state. This distinguishes definitive rejection, final delivery failure, and unknown acceptance. Only authenticated, correlated provider evidence can resolve uncertainty; a timer cannot manufacture evidence of non-acceptance.

## Transition ordering

Serialize changes for a challenge with a PostgreSQL row lock. State changes, idempotency results, delivery record, and queued work commit together where they belong to the same operation. Release database locks before provider HTTP calls.

Each routing decision records an increasing routing revision. Pending jobs carry the revision that created them. Before dispatch, the worker checks that revision together with challenge state, expiry, allowed provider, and shared budgets. A superseded revision cannot schedule or dispatch another send.

Send responses and callbacks use the same merge rules. Callbacks may update older attempts. Only the current applicable attempt can advance routing on failure. A late failure from before a user-requested resend or selection cannot advance the new action's route. Deduplicate each logical advancement under the challenge lock. A late `accepted` report cannot overwrite `delivered` or a confirmed final failure. Authenticated delivery evidence can resolve an earlier uncertain or failed outcome; contradictory reports remain diagnostic evidence and never retract delivery merely by arriving later.

Under D061, newly confirmed delivery from any attempt stops automatic routing for the current user action and suppresses pending automatic fallback. Preserve a pending explicit user send. Each newly accepted user action resets that stop flag; an already-known delivery or duplicate receipt does not set it again. Attempts already dispatched may complete. Queue jobs recheck the persisted flag before sending. This permits a user to request another delivery after a confirmed delivery they could not find.

Verification and cancellation invalidate pending routing work in the same transaction as their terminal state change. A provider call that already crossed the dispatch gate may still complete after verification. Persist its redacted outcome without reopening the challenge or sending another message. The API must not promise that local cancellation can undo an external request.

pg-boss owns leases and worker recovery. Test lease settings and provider receipt mappings against the selected versions. Recovery must preserve an unresolved dispatch as uncertain.

## Dispatch safeguards

Check eligibility before queueing and again at dispatch; reserve send budgets atomically before the provider call. Apply the saved policy and [configuration-change rules](operations.md#configuration-changes). User actions cannot bypass excluded providers or startup disables.

Queue payloads contain internal IDs. Persist external outcomes separately from queue completion. Database locks and queue deduplication cannot guarantee exactly-once external delivery.

## Verification

The [product scenarios](specifications.md#acceptance-scenarios) own expected behavior. Add concurrency tests for competing user actions, callback and user-action races, and recovery from an unresolved dispatch. Use real PostgreSQL and fake providers under D051.
