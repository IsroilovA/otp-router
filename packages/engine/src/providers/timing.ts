export interface DeliveryTiming {
  readonly minDeliveryWindowMs: number;
  readonly sendTimeoutMs: number;
}

export const deliveryWindowFits = (timing: DeliveryTiming, remainingMs: number): boolean =>
  timing.minDeliveryWindowMs + timing.sendTimeoutMs < remainingMs;
