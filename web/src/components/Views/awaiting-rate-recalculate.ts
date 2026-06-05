import {
  buildBatchRecalculateProgress,
  type BatchRecalculateRowState,
} from './orders-parity'

export type AwaitingRecalculateOrderRef = {
  orderId: number
  orderStatus?: string | null
}

export type RecalculatePreflightResult =
  | { queueable: true }
  | { queueable: false; row: BatchRecalculateRowState }

export function buildFilteredAwaitingRecalculateQuery(query: Record<string, unknown>) {
  return {
    ...query,
    orderStatus: 'awaiting_shipment',
  }
}

export function prepareBatchRecalculateRows<T extends AwaitingRecalculateOrderRef>(
  orders: T[],
  preflight: (order: T) => RecalculatePreflightResult,
) {
  const rows: Record<number, BatchRecalculateRowState> = {}
  const queueableOrders: T[] = []

  for (const order of orders) {
    const result = preflight(order)
    if (result.queueable) {
      rows[order.orderId] = { status: 'pending' }
      queueableOrders.push(order)
    } else {
      rows[order.orderId] = result.row
    }
  }

  return { rows, queueableOrders }
}

export function formatBatchRecalculateFinishedMessage(
  rows: Record<number, BatchRecalculateRowState>,
  skippedImmutable: number,
) {
  const summary = buildBatchRecalculateProgress(rows)
  const skippedText = skippedImmutable > 0 ? `, ${skippedImmutable} immutable skipped` : ''
  return {
    summary,
    message: `Recalculate finished: ${summary.updated} updated, ${summary.cleared} unavailable, ${summary.blocked + summary.timedOut} need retry${skippedText}`,
  }
}
