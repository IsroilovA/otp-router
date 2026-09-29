# Attempt history and reconciliation

Operation and challenge snapshots describe current state. Use attempt history and the project event feed for retained evidence. The [public schemas](../packages/engine/src/notifications/history-contracts.ts) and [HTTP reference](api.md) define wire shapes.

## Facts and projections

Attempt identity and project/operation ownership are stable. Authorization and invocation are separate from provider evidence. A durable dispatch commitment means transmission is possible; it does not establish that the provider was called or accepted a message.

Attempt updates preserve successive meaningful public projections. Private authorization lease and retry bookkeeping does not advance public revisions or extend history retention. Evidence events preserve normalized send responses and authenticated callbacks, including observations that do not change the routing decision. Router observation time establishes when evidence became known; provider-reported time is separate and does not determine feed order. Duplicate callback identities add no new facts.

Provider acceptance, confirmed delivery, rejection before acceptance, later delivery failure, and uncertainty remain distinguishable. Acceptance followed by failure retains acceptance evidence. An attempt suppressed before invocation is not a provider rejection. Contradictory or late evidence remains observable without granting a new send.

Terminal operation/challenge snapshots stay terminal. During retention, new evidence can update an attempt and publish events without reopening verification or advancing the route. History and events exclude codes, full phone numbers, binding/routing context, credentials, reservation secrets, and raw provider payloads. Diagnostics are allowlisted; private callback correlation and deduplication values are retained only as keyed digests.

## Ordering and pagination

Events commit atomically with domain changes and notification work. Each project has its own monotonically increasing committed sequence, represented as a decimal string. Sequences order publication, not provider occurrence time. Webhooks can arrive out of order or repeatedly; deduplicate by event ID and apply attempt revisions when updating an attempt projection. A receiver must process evidence events independently of whether an operation snapshot changed.

Event cursors are opaque and bound to the project and filters. A page reports its high-water mark. Continue until `hasMore` is false to finish that bounded catch-up; using the returned cursor again follows later commits. Concurrent publication must not cause readers to skip events.

Operation and attempt listings use committed creation order and a bounded high-water mark. Their snapshots can reflect newer evidence while pagination runs. Event-feed cleanup does not invalidate cursors for retained operation or attempt listings. To rebuild a projection, first save an event cursor/high-water mark, enumerate retained operations and attempts, and then consume the feed from that cursor. Deduplication and revision checks handle overlap. Reconciliation reads never invoke providers.

## Retention window

Redacted history defaults to thirty days. Active history remains available. Completed history is retained for the configured window after the later of completion or its latest evidence. Late evidence receives a full reconciliation window. Reads expose retention deadlines where applicable. Callback correlation and deduplication remain while the retained attempt needs them; unmatched callbacks use the configured window.

The feed exposes the configured reconciliation duration. When cleanup removes events, it advances a conservative replay floor. A cursor older than that floor returns `history_cursor_expired`; the router never silently claims a complete continuation. Restart from retained operation/attempt listings and the retained feed. Data older than the guarantee may already be gone. After fingerprint-key retirement, an old signed cursor can become invalid and must also be restarted.

Delivered notifications and events are eligible for deletion only after subject history is removed and their event/acknowledgement retention windows have elapsed. Pending or failed notifications retain their immutable events for operator replay. This extra retention is not an unlimited reconciliation guarantee.

History retention does not extend [secret retention](security.md#retention) or [request replay lifetimes](data-model.md#replay-and-retention).
