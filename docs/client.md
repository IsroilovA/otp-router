# TypeScript client

Use `@otp-router/client` from a trusted Node.js backend to call a self-hosted router. The initial `0.1.0-alpha.1` client targets the `0.1.0-alpha.1` server's `/v1` API. Client and server versions may advance independently; release verification tests their supported pairing. Alpha releases may break compatibility.

Install the `next` channel for prereleases. The [package README](../packages/client/README.md) owns installation, configuration, error handling and timeout examples; emitted declarations own signatures and DTO fields. The [runnable example](../examples/client/README.md) exercises both capabilities against the local fake deployment.

Request transfer DTOs and decoded response DTOs derive from the server's endpoint schemas and are validated at the HTTP boundary. Stable API errors use shared fields and a code-discriminated DTO; incorrect-code errors additionally distinguish lockout. Catch the client error classes and narrow their DTOs instead of matching message text. Network, deadline, caller-abort and invalid-response failures remain distinguishable.

Every mutation requires a caller-supplied idempotency key, and the client never retries automatically. Persist the intended payload and its key before sending. A timeout or cancelled request can still have committed on the server. Follow the [idempotency and reconciliation contract](api.md#idempotency), including same-key retries and revision checks for stale replays. Do not treat transport success, provider acceptance, or an external delivery status as proof of verification.

Configure the base URL, project and backend service credential explicitly. A base URL may include a reverse-proxy path prefix. Redirects are rejected to keep authenticated requests on the configured destination. Requests have a finite deadline and accept cancellation signals; neither mechanism cancels durable server work. See [project isolation](projects.md) for authorization and credential obligations.

Use [history cursors](history.md) to page retained evidence and rebuild projections. The client does not maintain a background poller, retry loop or local projection; callers control reconciliation according to their application needs.
