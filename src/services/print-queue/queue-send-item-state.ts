export type QueueSendJobItemState =
  | 'ready'
  | 'preflight_blocked'
  | 'skipped_preflight'
  | 'validating_rate'
  | 'acquiring_lock'
  | 'provider_pending'
  | 'provider_pending_recovery'
  | 'purchased'
  | 'shipment_persisted'
  | 'queued'
  | 'failed_retryable'
  | 'failed_terminal';

export type QueueSendJobItemInput = {
  orderId: number;
  clientId?: number | null;
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
