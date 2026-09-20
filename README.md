# OTP Router

OTP Router is a planned standalone self-hosted HTTP service written in TypeScript for generating, delivering, and verifying phone-number OTPs through configurable provider sequences. This repository currently contains design documents only.

## Current contracts

Read these documents as the current design. Each rule should have one owning document; cross-references summarize rather than redefine it.

- [Product specification](docs/specifications.md): scope, responsibilities, terminology, and acceptance scenarios.
- [Architecture](docs/architecture.md): components, deployment shape, and system boundaries.
- [Routing and delivery](docs/routing.md): fallback, user-requested resends, delivery state, and concurrency behavior.
- [API design](docs/api.md): HTTP operations, authorization, errors, and idempotency.
- [Verification and security](docs/security.md): OTP lifecycle, abuse controls, cryptography, and secret retention.
- [Provider and extension contracts](docs/plugins.md): provider adapters, routing selectors, templates, and localization.
- [Data model](docs/data-model.md): records, transactions, cleanup, and database invariants.
- [Deployment and operations](docs/operations.md): process roles, configuration changes, restore procedures, observability, and distribution.
- [Provider constraints](docs/provider-research.md): verified Telegram, WhatsApp, and Play Mobile behavior.

The [decision register](docs/decisions.md) is a historical index. When its summary conflicts with an owning contract, the owning contract is authoritative.

## Planning and evidence

- [Implementation plan](docs/development-plan.md) defines the implementation phases.
- [Private release checklist](docs/release-checklist.md) defines required test, provider, and benchmark evidence.
- [Implementation dependencies](docs/dependencies.md) records the selected stack and version policy.
- [Research archive](docs/research/) preserves dated evaluations and reproducible experiments. Research snapshots are evidence, not current version recommendations.

Items marked `Implementation` need code or evidence. Provider-specific unknowns are listed in the provider research.

Licensed under [MIT](LICENSE). Copyright 2026 Alisher Isorilov.
