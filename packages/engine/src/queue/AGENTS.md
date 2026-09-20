# Queue integration

- `makeQueueLayer` owns startup and shutdown. Build it only after router migrations. Leave pg-boss migrations enabled.
- Register cleanup before starting pg-boss. Its startup Promise is not cancellable; await completion before releasing its resources.
- Keep constructor/start failures typed. Finalizer failures are defects. Never include raw driver errors, connection strings, or job payloads in logs or errors.
- `Queue` exposes the internal pg-boss client for integration work. Feature code must use typed queue operations; do not scatter raw Promise calls or lifecycle calls through features.
- Transactional enqueue must use the application's current transaction. Queue retries resume persisted state and never authorize another provider send.
