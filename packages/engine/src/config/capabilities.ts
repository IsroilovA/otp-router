import { createHash } from "node:crypto";
import { canonical } from "../crypto.js";
import type { RuntimeConfiguration } from "./config.js";
export const capabilityFingerprint = (
  config: Omit<RuntimeConfiguration, "capabilityFingerprint">,
) =>
  createHash("sha256")
    .update(
      canonical({
        selectors: Object.entries(config.selectors)
          .map(([id, selector]) => ({ id, version: selector.version }))
          .toSorted((a, b) => a.id.localeCompare(b.id)),
        historyRetentionDays: config.settings.historyRetentionDays,
        webhook: config.settings.webhook !== undefined,
        deploymentSendLimit15m: config.settings.deploymentSendLimit15m,
        deploymentSendLimit24h: config.settings.deploymentSendLimit24h,
        recipientSendLimit15m: config.settings.recipientSendLimit15m,
        recipientCreateLimit15m: config.settings.recipientCreateLimit15m,
        recipientGuessLimit15m: config.settings.recipientGuessLimit15m,
        principalIds: config.settings.administration.principalIds.toSorted(),
        administrators: config.settings.administration.administrators,
        authorizationFloor: config.settings.administration.authorizationFloor,
        authorizer: config.authorizer !== undefined,
        verification: config.settings.crypto.verification !== undefined,
        adapters: [...config.adapters.values()]
          .map((p) => ({
            id: p.id,
            version: p.version,
            contract: p.contractVersion,
            schema: p.schemaVersion,
          }))
          .toSorted((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest("hex");
