import type { ReadyProvider } from "./contract.js";

export const providerDiagnostic = (
  provider: Pick<ReadyProvider, "diagnosticCodes"> | undefined,
  code: string | undefined,
): string =>
  code !== undefined && provider?.diagnosticCodes.includes(code) === true ? code : "unclassified";
