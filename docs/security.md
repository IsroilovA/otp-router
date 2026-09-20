# Verification and security

The router generates a cryptographically random numeric code and binds its verifier to the deployment, challenge, purpose, and application-supplied context. Preserve leading zeros. The adopting backend authorizes the business action and consumes the verification result once; the router does not issue login tokens.

## Verification and abuse limits

Compare purpose and context before checking a code or consuming a guess. Successful verification produces one durable result. A new operation key cannot verify an already verified challenge again. Replays retrieve the original result.

Enforce per-challenge guess and send limits, recipient-wide creation/send/guess limits, and deployment send caps. Provider caps can further restrict sends. Changing purpose, policy, channel, or challenge does not reset recipient usage. The adopting application's public endpoints also need abuse controls.

Use database-backed rolling windows. Count a wrong guess only when an active, correctly bound request reaches comparison and fails. Existing quota rejections and replays consume nothing. Recipient guess limits can temporarily block correct submissions; the challenge's own exhausted guess budget permanently locks it.

Reserve every provider invocation before network work. Failed and uncertain sends retain their reservation. A send-count cap is not an exact monetary budget.

Parse international numbers with the maintained phone-number library and normalize to E.164 before quota lookup. Require a country code; never infer a local region. Format validation does not establish ownership or reachability.

Configuration schemas define defaults and supported bounds. Providers may narrow those bounds. See [routing](routing.md) for deadlines and delivery actions.

## Secrets and keys

Store the recipient and recoverable code encrypted with authenticated encryption. Store a keyed verifier separately. Bind ciphertext to its deployment, challenge, and field so it cannot be moved between records. Use independent keys for encryption, verification, request fingerprints, and recipient lookup.

Load secrets from the environment or a secret store. Never put OTPs, credentials, full recipients, context IDs, routing context, message text, raw provider payloads, or authorization headers in logs or metrics. Persist provider diagnostics only from the adapter's declared allowlist. Keep internal health and metrics endpoints private.

## Retention

Verification, cancellation, lockout, and expiry erase the code ciphertext, verifier, and verification-request code fingerprints. Remove the encrypted recipient when no bounded in-flight operation needs it. Delivery exhaustion alone does not erase the verifier.

Retain redacted challenge and delivery history for seven days after terminal state. Keep idempotent results for at least twenty-four hours and while associated work remains active. Quota events outlive their full accounting windows, including the daily deployment window. Cleanup cannot reset active quotas.

Provider-held records, backups, and external logs have separate retention. Restore requires the [invalidation procedure](operations.md#database-restore).

## Key rotation

During encryption, verification, or fingerprint-key rotation, add a new key ID, use it for new writes, and retain old keys until no stored records need them. Never replace a key's bytes under an existing ID. Check stored references before removing a key.

Keep the recipient-lookup key stable. Replacing it changes quota identities. Stop every API and worker, invalidate active challenges, then reconstruct complete usage from a trusted source or wait a full longest quota window from the stop time. Install the replacement consistently across roles and use the incident-only adoption command in the [operations guide](operations.md#recipient-key-replacement).

API credentials rotate independently through a brief overlap of two equally privileged keys. Rotation must not change idempotency identities or quotas.
