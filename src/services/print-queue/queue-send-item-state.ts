export type QueueSendJobItemState =
  | 'ready'
  | 'preflight_blocked'
  | 'skipped_preflight'
  | 'validating_rate'
  | 'acquiring_lock'
  | 'provider_pending'
  | 'provider_pending_recovery'
  | 'receipt_resume'
  | 'purchased'
  | 'shipment_persisted'
  | 'queued'
  | 'failed_retryable'
  | 'failed_terminal';

export type QueueSendJobItemInput = {
  orderId: number;
  clientId?: number | null;
  // Per user override unlock shipped data on 2026-07-21: PS-452 uses these
  // only to fence/reap Print Queue orchestration attempts.
  attemptCount?: number;
  generation?: number;
  state: QueueSendJobItemState;
  blockedReason?: string | null;
  errorMessage?: string | null;
  queueEntryId?: string | null;
  trackingNumber?: string | null;
  result?: Record<string, unknown> | null;
};

export type QueueSendJobItemRecord = QueueSendJobItemInput & {
  jobId: string;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export function queueSendPreflightHasBlockingOperation(input: {
  orderId: number;
  hasActivePurchaseLock: boolean;
  hasHeldProviderOperation: boolean;
  ignoreActivePurchaseLockOrderIds?: ReadonlySet<number>;
}): boolean {
  // Per user override unlock shipped data on 2026-07-21: never let the local
  // lock exemption hide an unresolved canonical provider operation.
  return input.hasHeldProviderOperation
    || (
      input.hasActivePurchaseLock
      && !input.ignoreActivePurchaseLockOrderIds?.has(input.orderId)
    );
}
