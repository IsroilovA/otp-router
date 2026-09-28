# Send authorization

Projects explicitly choose required or disabled authorization. Disabled projects use the same dispatch workflow with a recorded `not_required` decision. Required projects need a configured authority; unavailable or malformed authority responses never grant permission to send. Saved operations retain their authorization requirement.

The router owns delivery execution and evidence. The integrating authority owns capacity reservations, prices, balances, charges, credits, and financial records. Approval is neither evidence of transmission nor a chargeable outcome. Router send-count limits remain independent of external reservations.

## HTTP integration

Use the exported `httpSendAuthorizer` layer, or implement the exported `SendAuthorizer` service in trusted deployment code. The [authorization schemas](../packages/engine/src/delivery/authorization-contracts.ts) own the request and response contract; the [configuration example](../examples/config/authorized.config.ts) shows composition.

The HTTP adapter sends an idempotent PUT to the configured reservation collection URL with the attempt ID appended. Use a dedicated Bearer credential and HTTPS; literal loopback HTTP is supported for development. Redirects are forbidden. The authority authenticates the router, restricts its deployment/project scope, and validates the complete request. Only a validated decision in an HTTP 200 response is usable.

Persist the reservation and immutable request identity before returning approval. Repeating the same attempt request must return its existing decision or advance a pending decision, never reserve twice. Changed input under that identity must conflict. The same PUT also serves as reconciliation after a lost response. Final approvals and denials are immutable; an expired approval does not become a fresh reservation under the same ID. The authority must atomically enforce its capacity across concurrent attempt IDs.

Requests contain attribution, selected provider/channel, attempt reason, and a fixed latest invocation time. They contain no OTP, full recipient, binding context, arbitrary caller metadata, or pricing model. Every initial send, fallback, resend, and explicit selection has a separate attempt identity and authorization decision.

## Execution and recovery

The router durably creates the attempt, requests authorization outside a database transaction, commits approval, and then rechecks eligibility in a separate dispatch transaction. Approval validity, project blocks, routing revision, operation state, original deadline, provider restrictions, and local quotas must still permit dispatch. Quota reservation and the single dispatch claim commit before the provider call. No database transaction spans authority or provider network work.

Authorization retries use the same attempt identity with durable scheduling until its deadline. Authority timeouts, lost responses, defects, and interruption never authorize fallback or provider invocation. Recovery repairs missing jobs and expired authorization leases. A stale worker cannot overwrite another claim's decision or dispatch superseded work.

A route denial stops that attempt without fallback. A project denial additionally blocks new dispatches for that project until its supplied retry time and invalidates older unconsumed approvals. Already committed dispatches may complete. Expiry of the project block does not revive denied attempts or restore invalidated approvals; new work still requires authorization. Existing pending requests can resume reconciliation after the block. Verification stays available under its original expiry and guess limits.

Before dispatch commitment, an approved attempt may resume after a crash if it is still eligible. After commitment, a crash or lost acknowledgement means transmission is possible, even if the process actually died before calling the provider. Recovery records uncertainty and never repeats that invocation. Provider idempotency support does not relax this rule. An explicit resend creates a new authorized attempt and retains the original code, expiry, and guess limits.

## Unused reservations and late evidence

An approval can become unusable because of closure, verification, supersession, expiry, quota exhaustion, or provider restrictions. The router records noninvocation when it can establish it, including a late approval received after closure. These facts are available through [attempt events and reconciliation](history.md).

The authority consumes those facts and applies its release or expiry policy. There is no router-owned charge, refund, or release policy and no second financial ledger. Lost authorization responses can leave a reservation that the router has not observed; reconcile the same attempt and enforce a bounded reservation lifetime independently.

A confirmed noninvocation supports release. Dispatch uncertainty does not prove noninvocation. Reservation expiry prevents new authorized dispatch but says nothing about a call already committed or a late delivery. The authority must preserve enough identity and deduplication data to handle delayed authorization requests, out-of-order unused-attempt events, and late provider evidence. A terminal release record must prevent a delayed duplicate request from recreating the reservation.
