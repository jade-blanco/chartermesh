import type { ControlPlane } from "./service.ts";
import type { OutboxDelivery } from "./types.ts";

export interface OutboxDispatchResult {
  claimed: number;
  dispatched: number;
  failed: number;
  deadLettered: number;
}

export interface OutboxDispatcherOptions {
  owner: string;
  batchSize?: number;
  maxAttempts?: number;
  baseBackoffSeconds?: number;
  handler: (delivery: OutboxDelivery) => void | Promise<void>;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{1,79}$/u.test(message)
    ? message
    : "OUTBOX_HANDLER_FAILED";
}

export async function dispatchOutboxBatch(
  controlPlane: ControlPlane,
  options: OutboxDispatcherOptions,
): Promise<OutboxDispatchResult> {
  const deliveries = controlPlane.claimOutboxBatch({
    owner: options.owner,
    limit: options.batchSize,
  });
  const result: OutboxDispatchResult = {
    claimed: deliveries.length,
    dispatched: 0,
    failed: 0,
    deadLettered: 0,
  };
  for (const delivery of deliveries) {
    try {
      await options.handler(delivery);
      controlPlane.acknowledgeOutbox({
        id: delivery.id,
        owner: options.owner,
      });
      result.dispatched += 1;
    } catch (error) {
      const failed = controlPlane.failOutbox({
        id: delivery.id,
        owner: options.owner,
        errorCode: errorCode(error),
        maxAttempts: options.maxAttempts,
        baseBackoffSeconds: options.baseBackoffSeconds,
      });
      result.failed += 1;
      if (failed.deadLetteredAt) result.deadLettered += 1;
    }
  }
  return result;
}
