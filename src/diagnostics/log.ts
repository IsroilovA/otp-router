import { Effect } from "effect";
import type { ErrorCode } from "../challenges/contracts.js";
export interface Diagnostic {
  readonly event: "application_operation" | "provider_send" | "callback" | "recovery";
  readonly requestId?: string;
  readonly challengeId?: string;
  readonly deliveryId?: string;
  readonly providerInstanceId?: string;
  readonly outcome: string;
  readonly reason?: ErrorCode;
  readonly elapsedMilliseconds?: number;
}
// Only callers with normalized fields cross this boundary. Never accept an error/Cause or request object.
export const logEvent = (diagnostic: Diagnostic) =>
  Effect.sync(() => {
    process.stdout.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), level: "info", ...diagnostic })}\n`,
    );
  }).pipe(Effect.catchAllCause(() => Effect.void));
