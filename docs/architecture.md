# Architecture

The HTTP API and worker share challenge and delivery operations. PostgreSQL holds challenge state, quotas, idempotent results, and durable queue work through pg-boss. No other external service is required.

## Responsibilities

- `challenges/` owns creation, verification, cancellation, expiry, and secret retention.
- `delivery/` owns provider selection, explicit sends, dispatch, and outcome reconciliation.
- `providers/` translates provider protocols into normalized acceptance and delivery outcomes. Adapters neither verify codes nor choose fallback providers.
- `http/` authenticates and validates application requests and provider callbacks. `worker/` executes durable jobs.
- `database/`, `queue/`, and `config/` own their resource lifecycles and startup boundaries.

Domain operations use Effect with explicit expected failures. Layers construct scoped resources; effects run at process, transport, and test boundaries. Features do not import HTTP handlers or worker entry points.

## Delivery and verification

Delivery state and verification state are independent. A receipt cannot verify a challenge, and an exhausted delivery route does not invalidate its code.

Each delivery record permits at most one provider invocation. The worker commits eligibility and quota reservation before contacting the provider. It stores the outcome in a separate transaction. Queue retries resume durable state and cannot authorize another invocation of a dispatched record.

A process crash can leave delivery uncertain. Authenticated callbacks may resolve it; recovery never guesses that the message was rejected. See [routing](routing.md) and [transactions](data-model.md).

## Configuration and extensions

Each deployment serves one application and owns its database namespaces. Separate applications use separate databases.

A trusted TypeScript entry file constructs provider instances and named policies. A creation-time selector may choose an ordered subset of a policy's providers. The challenge saves its route and non-secret settings; credentials stay in process configuration.

Public extensions are [providers and routing selectors](plugins.md). Storage and domain operations remain internal. Applications in any language integrate over [HTTP](api.md).

The image supports combined, API-only, and worker-only roles. Use compatible configuration across roles and follow the [drain procedure](operations.md#configuration-changes) for incompatible changes.
