import type postgres from 'postgres';

export const INVENTORY_DEDUCTION_REPORT_EVENT = 'inventory_deduction_requested';
// Per user override unlock shipped data on 2026-08-25: PS-497 Release B (S2.8, Hermes #6a). The dedicated
// occurrence-deduction lane the report must also surface, distinct from the quarantined legacy lane.
export const OCCURRENCE_DEDUCTION_REPORT_EVENT = 'fulfillment_occurrence_deduction_requested';

export type InventoryDeductionReportState =
  | 'parked_kill_switch'
  // Per user override unlock shipped data on 2026-08-25: PS-497 Release B (S2.8, Hermes #6a). Under Release B
  // the legacy inventory_deduction_requested lane is QUARANTINED (the generic worker never claims it and its
  // processor fails closed). A pending row there is NOT due work — it is a preserved-but-inert record. The
  // report labels it `parked_legacy`, never `pending`, so the quarantine-hardening gate can prove
  // parked-legacy vs occurrence-owned work.
  | 'parked_legacy'
  | 'pending'
  | 'processing'
  | 'retrying'
  | 'exhausted';

/** The dedicated occurrence-deduction lane's outbox states (the lane that actually executes in Release B). */
export type OccurrenceLaneState = 'pending' | 'processing' | 'retrying' | 'exhausted' | 'succeeded';

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

export type OccurrenceLaneReport = {
  /** The dedicated occurrence lane's counts by state (the executing lane in Release B). */
  counts: Record<OccurrenceLaneState, number>;
};

export type InventoryDeductionReport = {
  readOnly: true;
  inventoryAutoDeductEnabled: boolean;
  /** true under Release B: the legacy lane is quarantined and its rows are labeled parked_legacy. */
  legacyLaneQuarantined: boolean;
  generatedAt: string;
  limit: number;
  counts: Record<InventoryDeductionReportState, number>;
  rows: InventoryDeductionReportRow[];
  /** Hermes #6a: the occurrence lane, reported separately from the parked legacy lane. */
  occurrenceLane: OccurrenceLaneReport;
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
  legacyLaneQuarantined = false,
): InventoryDeductionReportState {
  // Under Release B the legacy lane is quarantined by CODE (not a runtime flag): the generic worker never
  // claims it and its processor fails closed. So an unsettled legacy row will NEVER execute — it is
  // parked_legacy regardless of the master kill switch (which now only gates the occurrence executor).
  if (legacyLaneQuarantined) return 'parked_legacy';
  if (!inventoryAutoDeductEnabled) return 'parked_kill_switch';
  if (row.status === 'processing') return 'processing';
  if (row.status === 'failed') {
    return isInfiniteTimestamp(row.next_run_at) ? 'exhausted' : 'retrying';
  }
  return 'pending';
}

/** Count the dedicated occurrence lane by state (the lane that actually executes in Release B). */
async function readOccurrenceLaneReport(executor: InventoryDeductionReportSql): Promise<OccurrenceLaneReport> {
  const rows = await executor<Array<{ status: string; next_run_at: Date | string; n: number }>>`
    SELECT status, MIN(next_run_at) AS next_run_at, COUNT(*)::int AS n
    FROM fulfillment_outbox
    WHERE event_type = ${OCCURRENCE_DEDUCTION_REPORT_EVENT}
    GROUP BY status
  `;
  const counts: Record<OccurrenceLaneState, number> = {
    pending: 0, processing: 0, retrying: 0, exhausted: 0, succeeded: 0,
  };
  for (const row of rows) {
    if (row.status === 'succeeded') counts.succeeded += row.n;
    else if (row.status === 'processing') counts.processing += row.n;
    else if (row.status === 'failed') {
      // A GROUP BY collapses many rows; classify the group by whether ANY is still retryable. MIN(next_run_at)
      // = 'infinity' only when every failed row is exhausted.
      if (isInfiniteTimestamp(row.next_run_at)) counts.exhausted += row.n;
      else counts.retrying += row.n;
    } else counts.pending += row.n; // 'pending'
  }
  return { counts };
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
    /** Release B passes true: the legacy lane is quarantined; its rows are labeled parked_legacy. */
    legacyLaneQuarantined?: boolean;
    limit?: number;
    now?: Date;
  },
): Promise<InventoryDeductionReport> {
  const legacyLaneQuarantined = options.legacyLaneQuarantined ?? false;
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
    parked_legacy: 0,
    pending: 0,
    processing: 0,
    retrying: 0,
    exhausted: 0,
  };
  const reportRows = rows.map((row): InventoryDeductionReportRow => {
    const state = classifyInventoryDeductionReportRow(
      row,
      options.inventoryAutoDeductEnabled,
      legacyLaneQuarantined,
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

  const occurrenceLane = await readOccurrenceLaneReport(executor);

  return {
    readOnly: true,
    inventoryAutoDeductEnabled: options.inventoryAutoDeductEnabled,
    legacyLaneQuarantined,
    generatedAt: (options.now ?? new Date()).toISOString(),
    limit,
    counts,
    rows: reportRows,
    occurrenceLane,
  };
}
