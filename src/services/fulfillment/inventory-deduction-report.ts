import type postgres from 'postgres';

export const INVENTORY_DEDUCTION_REPORT_EVENT = 'inventory_deduction_requested';

export type InventoryDeductionReportState =
  | 'parked_kill_switch'
  | 'pending'
  | 'processing'
  | 'retrying'
  | 'exhausted';

type InventoryDeductionReportSql = postgres.Sql;

type InventoryDeductionOutboxRow = {
  id: number;
  order_id: number;
  shipment_id: number | null;
  payload: Record<string, unknown> | null;
  status: string;
  attempts: number;
  last_error: string | null;
  next_run_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

export type InventoryDeductionReportRow = {
  id: number;
  orderId: number;
  shipmentId: number | null;
  lifecycleEventId: number | null;
  state: InventoryDeductionReportState;
  outboxStatus: string;
  attempts: number;
  lastError: string | null;
  nextRunAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type InventoryDeductionReport = {
  readOnly: true;
  inventoryAutoDeductEnabled: boolean;
  generatedAt: string;
  limit: number;
  counts: Record<InventoryDeductionReportState, number>;
  rows: InventoryDeductionReportRow[];
};

const REPORT_LIMIT_DEFAULT = 100;
const REPORT_LIMIT_MAX = 500;

function boundedLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return REPORT_LIMIT_DEFAULT;
  return Math.max(1, Math.min(REPORT_LIMIT_MAX, Math.trunc(limit!)));
}

function isInfiniteTimestamp(value: Date | string): boolean {
  if (value instanceof Date) return Number.isNaN(value.getTime());
  return value.trim().toLowerCase() === 'infinity';
}

function lifecycleEventId(payload: Record<string, unknown> | null): number | null {
  const value = Number(payload?.lifecycleEventId);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function classifyInventoryDeductionReportRow(
  row: Pick<InventoryDeductionOutboxRow, 'status' | 'next_run_at'>,
  inventoryAutoDeductEnabled: boolean,
): InventoryDeductionReportState {
  if (!inventoryAutoDeductEnabled) return 'parked_kill_switch';
  if (row.status === 'processing') return 'processing';
  if (row.status === 'failed') {
    return isInfiniteTimestamp(row.next_run_at) ? 'exhausted' : 'retrying';
  }
  return 'pending';
}

/**
 * Read-only operator view over unsettled inventory-deduction outbox work.
 *
 * The fulfillment outbox and deduction owner remain the only writers. This
 * projection deliberately does not join customer/order detail, so it exposes
 * operational identifiers and retry state without customer PII.
 */
export async function getInventoryDeductionReport(
  executor: InventoryDeductionReportSql,
  options: {
    inventoryAutoDeductEnabled: boolean;
    limit?: number;
    now?: Date;
  },
): Promise<InventoryDeductionReport> {
  const limit = boundedLimit(options.limit);
  const rows = await executor<InventoryDeductionOutboxRow[]>`
    SELECT
      id,
      order_id,
      shipment_id,
      payload,
      status,
      attempts,
      last_error,
      next_run_at,
      created_at,
      updated_at
    FROM fulfillment_outbox
    WHERE event_type = ${INVENTORY_DEDUCTION_REPORT_EVENT}
      AND status IN ('pending', 'processing', 'failed')
    ORDER BY status ASC, next_run_at ASC, id ASC
    LIMIT ${limit}
  `;

  const counts: Record<InventoryDeductionReportState, number> = {
    parked_kill_switch: 0,
    pending: 0,
    processing: 0,
    retrying: 0,
    exhausted: 0,
  };
  const reportRows = rows.map((row): InventoryDeductionReportRow => {
    const state = classifyInventoryDeductionReportRow(
      row,
      options.inventoryAutoDeductEnabled,
    );
    counts[state] += 1;
    return {
      id: row.id,
      orderId: row.order_id,
      shipmentId: row.shipment_id,
      lifecycleEventId: lifecycleEventId(row.payload),
      state,
      outboxStatus: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  return {
    readOnly: true,
    inventoryAutoDeductEnabled: options.inventoryAutoDeductEnabled,
    generatedAt: (options.now ?? new Date()).toISOString(),
    limit,
    counts,
    rows: reportRows,
  };
}
