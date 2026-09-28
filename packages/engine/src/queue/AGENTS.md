# Queue integration

- Own pg-boss startup and shutdown through a scoped Layer. Leave its migrations enabled.
- Register cleanup before starting pg-boss. Its startup Promise is not cancellable; await completion before releasing its resources.
- Keep constructor/start failures typed. Finalizer failures are defects. Never include raw driver errors, connection strings, or job payloads in logs or errors.
- Expose typed queue operations to features; keep raw Promise and lifecycle calls here.
- Capture the transaction context at enqueue time; the per-call adapter must not escape or be cached. Await its non-cancellable work before transaction cleanup.
- Queue payloads contain references, never plaintext recipients or codes. Retries resume persisted state; they do not authorize a new send.
