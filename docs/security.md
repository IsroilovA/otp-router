# Verification and security

For managed challenges, the router generates a cryptographically random numeric code and binds its verifier to the deployment, project, challenge, purpose, and application-supplied context. Preserve leading zeros. The adopting backend authorizes the business action and consumes the verification result once; the router does not issue login tokens.

## Verification and abuse limits

Compare purpose and context before checking a code or consuming a guess. Successful verification produces one durable result. A new operation key cannot verify an already verified challenge again. Replays retrieve the original result.

Enforce per-challenge guess and send limits, project-scoped recipient creation/send/guess limits, and deployment send caps. Provider caps can further restrict sends. Changing purpose, policy, channel, or challenge does not reset recipient usage within a project. See [limit scopes](projects.md#limit-scopes). The adopting application's public endpoints also need abuse controls.

Limits use durable rolling windows. Count a wrong guess only when an active, correctly bound request reaches comparison and fails. Quota rejections and replays consume nothing. Recipient guess limits can temporarily block correct submissions; exhausting the challenge's guess budget permanently locks it.

Reserve every provider invocation before network work. Failed and uncertain sends retain their reservation. A send-count cap is not an exact monetary budget.

Require international numbers with a country code and normalize to E.164 before quota lookup. Never infer a local region. Format validation does not establish ownership or reachability.

Configuration schemas define defaults and supported bounds. Providers may narrow those bounds. See [routing](routing.md) for deadlines and delivery actions.

## Secrets and keys

Store the recipient and recoverable code encrypted with authenticated encryption. Store a keyed verifier separately. Bind ciphertext to its deployment, project, delivery operation, and field so it cannot be moved between records. Use independent keys for encryption, verification, request fingerprints, and recipient lookup.

Load secrets from the environment or a secret store. Never put OTPs, credentials, full recipients, context IDs, routing context, message text, raw provider payloads, or authorization headers in logs, metrics, or errors. Persist only allowlisted provider diagnostics. Keep internal health and metrics endpoints private.

## Retention

Verification, cancellation, lockout, and expiry erase the code ciphertext, verifier, and verification-request code fingerprints. Remove the encrypted recipient when no bounded in-flight operation needs it. Delivery exhaustion alone does not erase the verifier.

See [retention guarantees](data-model.md#replay-and-retention) for history, receipts and quotas. Provider-held records, backups and external logs have separate retention.

## Key rotation

During encryption, verification, or fingerprint-key rotation, add a new key ID, use it for new writes, and retain old keys until no stored records need them. Never replace a key's bytes under an existing ID. Check stored references before removing a key.

Keep the recipient-lookup key stable: replacing it changes quota identities. Follow the [incident replacement procedure](operations.md#recipient-key-replacement).

Use independent credentials for API access, provider callbacks, and outbound event signing. [Webhook contracts](webhooks.md) own receiver authentication and event privacy requirements.

Follow the [API-key rotation procedure](operations.md#api-key-rotation) separately from data-key rotation.

## External code handoff

The [external lifecycle](engine.md#external-delivery) leaves verification with the caller. Delivery-only deployments need encryption, fingerprint, and stable recipient keys, but no verification key. Attachment and request fingerprints must remain cryptographically separated. Guess limits apply only to managed verification; [admission and send quotas](projects.md#limit-scopes) cover both capabilities.
