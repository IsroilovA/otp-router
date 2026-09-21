import type { CryptoConfig } from "../crypto.js";
export const verifierInput = (
  config: CryptoConfig,
  challenge: { readonly id: string; readonly purpose: string; readonly contextId: string },
  code: string,
) => [
  1,
  "verifier",
  config.deploymentId,
  challenge.id,
  challenge.purpose,
  challenge.contextId,
  code,
];
