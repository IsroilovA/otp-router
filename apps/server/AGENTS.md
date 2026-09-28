# HTTP server

- Own HTTP, authentication, OpenAPI, configuration loading, CLI, signals, readiness, and shutdown. Keep reusable application construction separate from CLI execution.
- Translate transport input and domain results at the boundary; keep routing, verification, and persistence in the engine.
- Load and redact deployment secrets before supplying settings to the engine. Configuration entries are trusted executable code, never request input.
- Endpoint schemas own wire shapes and generated OpenAPI. Change schemas and handlers together; never edit generated output.
- Authenticate bounded raw provider callback bytes before decoding. Keep backend API credentials separate from callback and outbound webhook authentication.
- Start resources before readiness; stop traffic and claims before draining and releasing them. Provider outages must not fail local readiness.
