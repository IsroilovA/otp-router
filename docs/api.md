# HTTP integration

Call the router from an authorized backend over a private network or TLS. A configured backend service principal authenticates with a Bearer credential and database-backed project grants; never expose that credential to browsers or mobile clients. See [project authentication and isolation](projects.md). Your backend must bind each operation to its authorized user/session and business action. An operation ID alone is not authorization.

TypeScript backends can use the [typed client](client.md), which follows this same HTTP contract.

Endpoint schemas own paths, request/response shapes, validation limits, and status codes. Generate their reference after building:

```sh
node apps/server/dist/main.js --openapi > openapi.json
```

## Integration flow

Choose [managed verification or external delivery](engine.md). Create, retain the operation ID and request key, then observe [public updates](webhooks.md). Creation acknowledges durable work, not provider acceptance. The local fake provider accepts sends without delivering a usable code.

The [HTTP walkthrough](../examples/http/README.md) runs both flows against the local server and shows a same-key replay after an ambiguous response.

For managed verification, submit the received code with its original purpose/context and preserve leading zeros. Consume the successful result once in your backend. Cancel when the flow ends without verification.

For external delivery, preserve the upstream deadline and attached code across channel changes. Close when the upstream flow ends; delivery status never authenticates the recipient.

## Integration correlation

Managed creation, external creation, and external preparation accept an optional `integrationReference`. Its [input schema](../packages/engine/src/delivery/input.ts) requires 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`; empty strings and `null` are invalid. Omit the field when no reference is needed. The router preserves its exact case and value without trimming or normalization.

Interpret the reference together with `projectId`. Multiple operations may share it, including within one project. It provides correlation only: it grants no access and changes no routing, verification binding, quota identity, or executable configuration. There is no reference lookup or filter. Keep the operation/challenge ID for subsequent actions.

The reference is immutable at creation or preparation. Code attachment cannot supply or change it. It survives attachment, fallback, resend, and manual selection, and appears when present in operation/challenge responses, verification receipts, history, supported events, and send-authorization requests. Public payloads omit it when absent. Delivery providers never receive it. Authorization reservations continue to use attempt identity.

Supply opaque identifiers, never personal data or secrets. Authorization services and webhook consumers receive the reference; protect and retain those copies appropriately. The router excludes it from routine logs and metric labels. Each containing operation, receipt, or immutable event follows its existing [retention rules](data-model.md#replay-and-retention), with no independent archive. Retained events and replay receipts preserve their original reference even after operation cleanup.

## Status and action forecasts

Acceptance means a provider accepted a send, not that the recipient received it. Delivery failure can leave verification available until its deadline and guess limit. A failed resend cannot erase another still-valid acceptance. Terminal verification states never reopen.

Public provider/channel describe confirmed acceptance, not route selection. During another send they may still identify the earlier acceptance. Use the separate [attempt history and event feed](history.md) for complete retained evidence.

Revisions advance for meaningful committed changes. Reads refresh server time without revision churn, though an overdue read can materialize expiry once. A webhook can arrive before its HTTP response; apply only higher revisions for the same subject and event kind.

Action forecasts describe the last published transition. Use absolute retry/expiry times and server time for countdowns. A timed denial can be reconsidered after its deadline without another event. Forecasts and retry headers neither reserve capacity nor extend expiry; every action is revalidated. See [routing](routing.md).

## Idempotency

Use a fresh random `Idempotency-Key` for each intended mutation and retain it with the payload for retries. Do not embed secrets or deliberately recycle keys. Keys are scoped to deployment, project, operation, and target where applicable; changed validated input conflicts with a saved request.

A matching replay returns the original status/body, marked by `Idempotency-Replayed`. The snapshot can be stale; use revisions and status reads to reconcile.

Creation/preparation fingerprints include `integrationReference`. Changing its exact value, adding it, or removing it under the same request identity conflicts; matching retries return the original receipt.

Verification compares the binding separately from the code. While active, a changed code conflicts. After a terminal transition erases code fingerprints, a syntactically valid changed code can replay the original result if the key and non-code fields match; this creates no new verification.

Wrong guesses and other committed outcomes complete the request key. Authentication failures, malformed input, rolled-back work, and transient quota/cooldown rejection do not. Replays consume no additional guesses or sends.

After a lost response, ambiguous commit, or server error, retry with bounded backoff using the same key and payload. An in-progress response does not prove failure. Respect retry deadlines; a state conflict calls for status reconciliation, and an input conflict calls for recovering the original request.

## Errors and callbacks

Branch on stable error codes, never message text. Lockout ends further guesses; an ordinary incorrect guess does not. Expired/cancelled operations cannot resume. Responses must be non-cacheable and free of sensitive details; never log request bodies or authorization headers.

Provider callbacks use independent authentication over bounded raw bytes. Acknowledge only after durable ingestion. Duplicate, early, or out-of-order reports cannot verify a challenge or repeat a routing transition. Each adapter owns its handshake protocol.

## Administration

Use `/v1/admin` with separate administrator credentials, or `createAdminClient()`. Endpoint schemas and generated OpenAPI own request shapes, paths, and error codes. Project reads and mutation responses include a strong `ETag`. All mutations require an `Idempotency-Key`; settings, lifecycle, and grant changes also require the previously read ETag in `If-Match`. Missing or malformed headers return `invalid_request`; stale revisions return `revision_conflict` (412). Current permission failures return `admin_forbidden` (403).

Persist the validated action, target, payload, key, and expected revision before sending. After a lost response, retry that exact request with the same key, including the original `If-Match`. Current authorization is checked before replay; replay is checked before a revision made stale by the original request. Matching retries return the original status, body, and ETag, with `Idempotency-Replayed: true`. Changed input under the same administrator/key identity conflicts. Read current state before making a different change.

Creation receipts never expire. Other administrative receipts retain seven days; after that window historical replay is not guaranteed and callers must reconcile current state. Retiring a project does not free its ID. Audit is separate from receipts and retained indefinitely. Project listings paginate by immutable ID; projects created before an already-consumed cursor appear on a fresh listing. Audit pagination follows project revision. Every page checks current administrator scope.

Runtime requests without a current grant return `project_access_denied` (403). Sending against a suspended or retired project returns `project_inactive` (409). A current grant is required even for replay. An authorized same-key replay returns its saved result without admitting new work, including while suspended or retired. See [project lifecycle](projects.md#lifecycle-and-sends) for committed-send and verification guarantees.
