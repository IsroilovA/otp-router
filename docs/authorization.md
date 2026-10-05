# Send authorization

Projects explicitly choose required or disabled authorization. Disabled projects use the same dispatch workflow with a recorded `not_required` decision. Required projects need a configured authority; unavailable or malformed authority responses never grant permission to send. Saved operations retain their authorization requirement.

The router owns delivery execution and evidence. The integrating authority owns capacity reservations, prices, balances, charges, credits, and financial records. Approval is neither evidence of transmission nor a chargeable outcome. Router send-count limits remain independent of external reservations.

## HTTP integration

Use the exported `httpSendAuthorizer` layer, or implement the exported `SendAuthorizer` service in trusted deployment code. The [authorization schemas](../packages/engine/src/delivery/authorization-contracts.ts) own the request and response contract; the [configuration example](../examples/config/authorized.config.ts) shows composition.

The HTTP adapter sends an idempotent PUT to the configured reservation collection URL with the attempt ID appended. Use a dedicated Bearer credential and HTTPS; literal loopback HTTP is supported for development. Redirects are forbidden. The authority authenticates the router, restricts its deployment/project scope, and validates the complete request. Only a validated decision in an HTTP 200 response is usable.

Persist the reservation and immutable request identity before returning approval. Repeating the same attempt request must return its existing decision or advance a pending decision, never reserve twice. Changed input under that identity must conflict. The same PUT also serves as reconciliation after a lost response. Final approvals and denials are immutable; an expired approval does not become a fresh reservation under the same ID. The authority must atomically enforce its capacity across concurrent attempt IDs.

Requests exclude OTPs, full recipients, binding context, arbitrary caller metadata, and prices. Every initial send, fallback, resend, and explicit selection has a separate attempt identity, deadline, and authorization decision.

Requests include the operation's optional [integration reference](api.md#integration-correlation) unchanged when present. Interpret it with `projectId` for correlation; multiple operations and attempts can share it. It is never the reservation or deduplication key.

## Execution and recovery

Approval does not reserve dispatch eligibility. Immediately before sending, the router rechecks approval validity, project blocks, routing revision, operation state, deadline, provider restrictions, and quotas. Reservation and the single dispatch commitment are durable before the provider call.

Authorization retries use the same attempt identity until its deadline, including after recovery. Timeouts, lost responses, defects, and interruption never authorize fallback or provider invocation. Stale workers cannot overwrite newer decisions or dispatch superseded work.

A route denial stops that attempt without fallback. A project denial additionally blocks new dispatches for that project until its supplied retry time and invalidates older unconsumed approvals. Already committed dispatches may complete. Expiry of the project block does not revive denied attempts or restore invalidated approvals; new work still requires authorization. Existing pending requests can resume reconciliation after the block. Verification stays available under its original expiry and guess limits.

Before dispatch commitment, an eligible approved attempt may resume after a crash. After commitment, a crash or lost acknowledgement means transmission is possible. Recovery waits for the in-flight deadline, then records uncertainty without repeating the invocation. Duplicate work and provider idempotency support cannot authorize a repeat. [Explicit resend](routing.md#user-actions) requires a new authorized attempt.

## Unused reservations and late evidence

An approval can become unusable because of closure, verification, supersession, expiry, quota exhaustion, or provider restrictions. The router records noninvocation when it can establish it, including a late approval received after closure. These facts are available through [attempt events and reconciliation](history.md).

The authority applies its own charge, refund, and reservation-release policies. Lost authorization responses can leave reservations the router has not observed; reconcile the same attempt and enforce a bounded reservation lifetime independently.

A confirmed noninvocation supports release. Dispatch uncertainty does not prove noninvocation. Reservation expiry prevents new authorized dispatch but says nothing about a call already committed or a late delivery. The authority must preserve enough identity and deduplication data to handle delayed authorization requests, out-of-order unused-attempt events, and late provider evidence. A terminal release record must prevent a delayed duplicate request from recreating the reservation.
