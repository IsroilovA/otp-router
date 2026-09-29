# Queue integration

- Own pg-boss startup and shutdown through a scoped Layer. Leave its migrations enabled.
- Register cleanup before startup. Wait for non-cancellable work before releasing resources or transactions.
- Keep constructor/start failures typed and finalizer failures as defects. Redact driver errors and job payloads.
- Expose typed queue operations to features; keep raw Promise and lifecycle calls here.
- Join the caller's active transaction at enqueue time. Never reuse transaction-bound state across calls.
- Queue payloads contain references, never plaintext recipients or codes. Retries resume persisted state; they do not authorize a new send.
