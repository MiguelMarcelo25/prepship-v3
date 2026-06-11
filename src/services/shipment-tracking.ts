/**
 * shipment-tracking.ts — canonical shipment-tracking poller + delivered→queue retirement.
 *
 * Per user override unlock shipped data on 2026-06-11: this service READS the
 * locked shipments table (tracking number + carrier for orders with an active
 * print-queue entry) and NEVER writes orders/shipments — all tracking state
 * lives in the additive shipment_tracking_status side table, and the only
 * mutation it drives is the print-queue owner's 'queued' → 'delivered'
 * transition (a label for a package already in the customer's hands never
 * needs printing). Guard-pinned: no db.update/insert/delete on locked tables,
 * no raw tracking payloads persisted.
 *
 * Decisions live in the pure policy module (shipment-tracking-policy.ts);
 * the ShipStation v2 fetch lives in the TrackingConnector — this module owns
 * candidate selection, persistence, and orchestration only.
 */
import { desc, eq, sql as dsql } from 'drizzle-orm';
import { db, sql as pg } from '../db/client';
import { shipmentTrackingStatus } from '../db/schema/shipment-tracking-status';
import { shipStationTrackingConnector } from '../connectors/tracking/shipstation';
import {
  decidePrintQueueRetirement,
  type TrackingPolicyStatus,
} from './shipment-tracking-policy';
import { retireDeliveredQueueEntries } from './print-queue';

// ── Runtime schema ensure (mirrors drizzle/0042_shipment_tracking_status.sql; same
// pattern as order-rate-job-status.ts so worker/API both work pre-migration). ──
let schemaEnsured: Promise<void> | null = null;

export async function ensureShipmentTrackingSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS shipment_tracking_status (
        id serial PRIMARY KEY,
        order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        client_id integer,
        tracking_number text NOT NULL,
        carrier_code text,
        status text NOT NULL DEFAULT 'unknown',
        status_description text,
        delivered_at timestamptz,
        last_checked_at timestamptz NOT NULL DEFAULT now(),
        check_count integer NOT NULL DEFAULT 0,
        last_error text,
        source text NOT NULL DEFAULT 'shipstation_v2',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT shipment_tracking_status_order_tracking_unq UNIQUE (order_id, tracking_number)
      )
    `;
    await pg`CREATE INDEX IF NOT EXISTS shipment_tracking_status_order_idx ON shipment_tracking_status (order_id)`;
    await pg`CREATE INDEX IF NOT EXISTS shipment_tracking_status_poll_idx ON shipment_tracking_status (status, last_checked_at)`;
    await pg`ALTER TABLE shipment_tracking_status ENABLE ROW LEVEL SECURITY`;
    await pg`ALTER TABLE print_queue_orders ADD COLUMN IF NOT EXISTS auto_retired_at timestamptz`;
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
}

// Polling policy constants — deliberately code, not env (operator knobs are the
// two env flags; these are implementation pacing).
const POLL_BATCH_LIMIT = 50;
const RECHECK_WINDOW_MINUTES = 12;
const MAX_CHECKS_PER_TRACKING = 240; // ≈ 240 × 15min ticks ≈ 2.5 days of solid polling spread over the age cap
const QUEUE_AGE_CAP_DAYS = 45;

export type TrackingPollCandidate = {
  entryId: string;
  orderId: number;
  clientId: number | null;
  trackingNumber: string;
  carrierCode: string | null;
};

/**
 * Queued print-queue entries whose latest non-voided shipment has a tracking
 * number and is still worth polling. READ-ONLY over print_queue + shipments +
 * clients (lockdown: reads allowed). Excludes test clients and the
 * prepship_test fixture carrier; round-robins by last_checked_at so every
 * candidate gets a turn under the per-tick cap.
 */
export async function listTrackingPollCandidates(limit = POLL_BATCH_LIMIT): Promise<TrackingPollCandidate[]> {
  await ensureShipmentTrackingSchema();
  const rows = await pg<
    Array<{
      entry_id: string;
      order_id: number;
      client_id: number | null;
      tracking_number: string;
      carrier_code: string | null;
      last_checked_at: Date | null;
    }>
  >`
    SELECT * FROM (
      SELECT DISTINCT ON (pq.id)
        pq.id AS entry_id,
        (pq.order_id)::int AS order_id,
        pq.client_id,
        s.tracking_number,
        s.carrier_code,
        t.last_checked_at
      FROM print_queue_orders pq
      JOIN shipments s
        ON s.order_id = (pq.order_id)::int
        AND COALESCE(s.voided, false) = false
        AND s.tracking_number IS NOT NULL
        AND s.tracking_number <> ''
      LEFT JOIN clients c ON c.id = pq.client_id
      LEFT JOIN shipment_tracking_status t
        ON t.order_id = (pq.order_id)::int
        AND t.tracking_number = s.tracking_number
      WHERE pq.status = 'queued'
        AND s.carrier_code IS DISTINCT FROM 'prepship_test'
        AND COALESCE(c.is_test, false) = false
        AND pq.queued_at > now() - (${QUEUE_AGE_CAP_DAYS}::int * interval '1 day')
        AND (
          t.id IS NULL
          OR (
            t.status <> 'delivered'
            AND t.last_checked_at < now() - (${RECHECK_WINDOW_MINUTES}::int * interval '1 minute')
            AND t.check_count < ${MAX_CHECKS_PER_TRACKING}
          )
        )
      ORDER BY pq.id, s.id DESC
    ) candidates
    ORDER BY candidates.last_checked_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    entryId: row.entry_id,
    orderId: Number(row.order_id),
    clientId: row.client_id == null ? null : Number(row.client_id),
    trackingNumber: row.tracking_number,
    carrierCode: row.carrier_code ?? null,
  }));
}

type UpsertTrackingInput = {
  orderId: number;
  clientId: number | null;
  trackingNumber: string;
  carrierCode: string | null;
  status: TrackingPolicyStatus | string;
  statusDescription: string | null;
  deliveredAt: string | null;
  lastError: string | null;
};

async function upsertTrackingStatus(input: UpsertTrackingInput): Promise<void> {
  const deliveredAt = input.deliveredAt ? new Date(input.deliveredAt) : null;
  await db
    .insert(shipmentTrackingStatus)
    .values({
      orderId: input.orderId,
      clientId: input.clientId,
      trackingNumber: input.trackingNumber,
      carrierCode: input.carrierCode,
      status: String(input.status),
      statusDescription: input.statusDescription,
      deliveredAt: deliveredAt && !Number.isNaN(deliveredAt.getTime()) ? deliveredAt : null,
      lastCheckedAt: new Date(),
      checkCount: 1,
      lastError: input.lastError,
    })
    .onConflictDoUpdate({
      target: [shipmentTrackingStatus.orderId, shipmentTrackingStatus.trackingNumber],
      set: {
        status: String(input.status),
        statusDescription: input.statusDescription,
        carrierCode: input.carrierCode,
        deliveredAt: dsql`COALESCE(${deliveredAt && !Number.isNaN(deliveredAt.getTime()) ? deliveredAt : null}, ${shipmentTrackingStatus.deliveredAt})`,
        lastCheckedAt: new Date(),
        checkCount: dsql`${shipmentTrackingStatus.checkCount} + 1`,
        lastError: input.lastError,
        updatedAt: new Date(),
      },
    });
}

export type ShipmentTrackingPollResult = {
  candidates: number;
  checked: number;
  delivered: number;
  retired: number;
  unknown: number;
  errors: number;
};

/**
 * One poller tick: fetch tracking for each candidate, persist the redacted
 * status, and — when the policy says retire AND the autoRetire flag is on —
 * delegate the 'queued' → 'delivered' transition to the print-queue owner.
 * Per-candidate failures never abort the batch.
 */
export async function runShipmentTrackingPollOnce(opts: { limit?: number; autoRetire?: boolean } = {}): Promise<ShipmentTrackingPollResult> {
  await ensureShipmentTrackingSchema();
  const candidates = await listTrackingPollCandidates(opts.limit ?? POLL_BATCH_LIMIT);
  const result: ShipmentTrackingPollResult = {
    candidates: candidates.length,
    checked: 0,
    delivered: 0,
    retired: 0,
    unknown: 0,
    errors: 0,
  };
  const toRetire: Array<{ entryId: string; deliveredAt: Date | null }> = [];

  for (const candidate of candidates) {
    try {
      const tracked = await shipStationTrackingConnector.trackShipment({
        trackingNumber: candidate.trackingNumber,
        carrierCode: candidate.carrierCode,
      });
      result.checked += 1;
      if (tracked.status === 'unknown') result.unknown += 1;
      if (tracked.status === 'delivered') result.delivered += 1;
      await upsertTrackingStatus({
        orderId: candidate.orderId,
        clientId: candidate.clientId,
        trackingNumber: candidate.trackingNumber,
        carrierCode: candidate.carrierCode,
        status: tracked.status,
        statusDescription: tracked.statusDescription ?? null,
        deliveredAt: tracked.deliveredAt ?? null,
        lastError: null,
      });
      if (
        decidePrintQueueRetirement({ trackingStatus: tracked.status, entryStatus: 'queued' }) === 'retire'
      ) {
        const deliveredAt = tracked.deliveredAt ? new Date(tracked.deliveredAt) : null;
        toRetire.push({
          entryId: candidate.entryId,
          deliveredAt: deliveredAt && !Number.isNaN(deliveredAt.getTime()) ? deliveredAt : null,
        });
      }
    } catch (err) {
      result.errors += 1;
      const message = err instanceof Error ? err.message.slice(0, 300) : 'tracking fetch failed';
      console.warn(
        `[shipment-tracking] ${candidate.trackingNumber} (order ${candidate.orderId}): ${message}`,
      );
      // Best-effort error stamp so the poll index backs off this row too.
      await upsertTrackingStatus({
        orderId: candidate.orderId,
        clientId: candidate.clientId,
        trackingNumber: candidate.trackingNumber,
        carrierCode: candidate.carrierCode,
        status: 'unknown',
        statusDescription: null,
        deliveredAt: null,
        lastError: message,
      }).catch(() => {});
    }
  }

  if (toRetire.length && opts.autoRetire === true) {
    const retired = await retireDeliveredQueueEntries({ entries: toRetire });
    result.retired = retired.retiredCount;
    if (retired.retiredCount > 0) {
      console.log(
        `[shipment-tracking] auto-retired ${retired.retiredCount} delivered queue entr${retired.retiredCount === 1 ? 'y' : 'ies'}`,
      );
    }
  }

  return result;
}

export type OrderTrackingSummary = {
  trackingNumber: string;
  status: string;
  statusDescription: string | null;
  deliveredAt: string | null;
  lastCheckedAt: string | null;
};

/** Newest tracking row for an order — the side panel's display line. */
export async function loadOrderTrackingSummary(orderId: number): Promise<OrderTrackingSummary | null> {
  if (!Number.isFinite(orderId)) return null;
  try {
    await ensureShipmentTrackingSchema();
    const [row] = await db
      .select()
      .from(shipmentTrackingStatus)
      .where(eq(shipmentTrackingStatus.orderId, orderId))
      .orderBy(desc(shipmentTrackingStatus.lastCheckedAt))
      .limit(1);
    if (!row) return null;
    return {
      trackingNumber: row.trackingNumber,
      status: row.status,
      statusDescription: row.statusDescription ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    };
  } catch (err) {
    // Display-only read — never let it break the order detail payload.
    console.warn('[shipment-tracking] summary load failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
