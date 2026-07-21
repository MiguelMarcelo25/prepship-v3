import type { QueueSendOrderInput } from '../print-queue';
import type { QueueSendJobItemInput } from './queue-send-item-state';
import type { QueueSendSnapshotResult } from './queue-send-snapshot';

export type QueueSendOutcomeName =
  | 'queued'
  | 'skipped'
  | 'failed'
  | 'provider_pending'
  | 'in_progress'
  | 'ready';

export type QueueSendNextAction =
  | 'none'
  | 'fund_account'
  | 'rerate'
  | 'retry_safe'
  | 'retry_later'
  | 'reconcile_provider';

export type QueueSendOrderOutcome = {
  orderId: number;
  orderNumber: string | number | null;
  state: string;
  outcome: QueueSendOutcomeName;
  reasonCode: string | null;
  reason: string | null;
  retryEligible: boolean;
  nextAction: QueueSendNextAction;
};

const RATE_RETRY_REASONS = new Set([
  'missing_rate_proof',
  'stale_or_mismatched_rate_proof',
  'missing_selected_rate',
  'missing_current_fingerprint',
  'missing_fingerprint',
  'fingerprint_mismatch',
  'not_in_current_eligible_rates',
  'snapshot_not_final',
  'backend_rate_quote_required',
  'snapshot_missing',
  'snapshot_expired',
  'selected_rate_not_in_snapshot',
  'proof_invalid',
]);

function outcomeForState(state: string): QueueSendOutcomeName {
  if (state === 'queued') return 'queued';
  if (state === 'preflight_blocked' || state === 'skipped_preflight') return 'skipped';
  if (state === 'failed_retryable' || state === 'failed_terminal') return 'failed';
  if (state === 'provider_pending' || state === 'provider_pending_recovery') {
    return 'provider_pending';
  }
  if (state === 'ready') return 'ready';
  return 'in_progress';
}

export function projectQueueSendOrderOutcomes(input: {
  workerOrders: QueueSendOrderInput[];
  itemStates?: QueueSendJobItemInput[];
  results?: QueueSendSnapshotResult[];
}): QueueSendOrderOutcome[] {
  const items = new Map((input.itemStates ?? []).map((item) => [item.orderId, item]));
  const results = new Map((input.results ?? []).map((result) => [result.orderId, result]));
  const orderIds = new Set<number>([
    ...input.workerOrders.map((order) => order.orderId),
    ...items.keys(),
    ...results.keys(),
  ]);
  const orders = new Map(input.workerOrders.map((order) => [order.orderId, order]));

  return [...orderIds].map((orderId) => {
    const order = orders.get(orderId);
    const item = items.get(orderId);
    const result = results.get(orderId);
    const state = item?.state
      ?? (result?.success ? 'queued' : result?.skipped ? 'skipped_preflight' : result ? 'failed_terminal' : 'ready');
    const outcome = outcomeForState(state);
    const reasonCode = item?.blockedReason ?? result?.retryReason ?? null;
    const reason = item?.errorMessage ?? result?.skipReason ?? result?.error ?? (
      outcome === 'provider_pending'
        ? 'The carrier outcome is not yet known. This order is fenced from repurchase until reconciliation completes.'
        : null
    );
    const rateRetry = reasonCode != null && RATE_RETRY_REASONS.has(reasonCode);
    const retryEligible = outcome === 'failed' && result?.retryEligible === true;
    const nextAction: QueueSendNextAction = outcome === 'provider_pending'
      || reasonCode === 'label_purchase_reconciliation_required'
      ? 'reconcile_provider'
      : reasonCode === 'insufficient_account_balance'
        ? 'fund_account'
      : reasonCode === 'provider_unavailable' || reasonCode === 'provider_rate_limited'
        ? 'retry_later'
      : reasonCode === 'rate_proof_check_unavailable'
        ? 'retry_later'
      : retryEligible && rateRetry
        ? 'rerate'
        : retryEligible
          ? 'retry_safe'
          : outcome === 'ready' || outcome === 'in_progress'
            ? 'retry_later'
            : 'none';
    return {
      orderId,
      orderNumber: order?.orderNumber ?? result?.orderNumber ?? null,
      state,
      outcome,
      reasonCode,
      reason,
      retryEligible,
      nextAction,
    };
  });
}
