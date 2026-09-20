import type { ReadyProvider } from "./contract.js";

export const providerDiagnostic = (
  provider: ReadyProvider | undefined,
  code: string | undefined,
): string =>
  code !== undefined && provider?.diagnosticCodes.includes(code) === true ? code : "unclassified";
