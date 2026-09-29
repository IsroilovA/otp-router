import { createHash } from "node:crypto";
import { canonical } from "../crypto.js";
import type { RuntimeConfiguration } from "./config.js";
export const catalogFingerprint = (config: Omit<RuntimeConfiguration, "catalogFingerprint">) =>
  createHash("sha256")
    .update(
      canonical({
        policies: config.settings.policies,
        selectors: Object.keys(config.selectors).toSorted(),
        defaultLocale: config.settings.defaultLocale,
        fallbackLocales: config.settings.fallbackLocales,
        deploymentSendLimit15m: config.settings.deploymentSendLimit15m,
        deploymentSendLimit24h: config.settings.deploymentSendLimit24h,
        providerSendLimits15m: config.settings.providerSendLimits15m,
        recipientSendLimit15m: config.settings.recipientSendLimit15m,
        recipientCreateLimit15m: config.settings.recipientCreateLimit15m,
        recipientGuessLimit15m: config.settings.recipientGuessLimit15m,
        purposes: config.settings.purposes,
        principalIds: config.settings.administration.principalIds.toSorted(),
        administrators: config.settings.administration.administrators,
        authorizationFloor: config.settings.administration.authorizationFloor,
        authorizer: config.authorizer !== undefined,
        verification: config.settings.crypto.verification !== undefined,
        providers: [...config.providers.values()]
          .map((p) => ({
            id: p.instanceId,
            plugin: p.pluginId,
            channel: p.channel,
            enabled: p.enabled,
            revision: p.compatibilityRevision,
            constraints: p.constraints,
            timeout: p.sendTimeoutMs,
          }))
          .toSorted((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest("hex");
