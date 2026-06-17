// PS-286 — forward-fix: capture shipments.label_url during the ShipStation sync.
//
// The v1 /shipments list payload (what shipment-sync ingests) has no hosted label URL, so
// synced shipments persist with label_url NULL and the Shipped view greys "Send to Queue".
// This best-effort enrichment runs right after each account's sync page-walk — the same
// shape as enrichProviderAccountIds — listing the account's recent v2 labels and FILLING
// any null label_url it can match by ShipStation shipment id. It delegates the fill rule to
// the pure, guarded planner (shipping-workflow/shipment-label-url-backfill).
//
// Per user override `unlock shipped data` on 2026-06-17: the ONLY write is filling a NULL
// label_url. The `isNull(label_url)` where-clause guarantees it never overwrites an existing
// URL and touches no other shipped/cancelled column. Best-effort: any failure is swallowed
// by the caller so it can never block the sync.

import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shipments } from '../db/schema/shipments.js';
import { ssListRecentLabels } from '../lib/shipstation/labels.js';
import {
  planShipmentLabelUrlBackfill,
  type LabelUrlRecord,
} from './shipping-workflow/shipment-label-url-backfill.js';

// Newly-shipped labels are the most recent, so a few pages cover a sync window.
// Smaller page size keeps each response fast (large label lists can be slow/time out).
const MAX_LABEL_PAGES = 4;
const LABEL_PAGE_SIZE = 200;

export async function enrichLabelUrls(
  acct: { label: string; apiKeyV2: string | null },
  sinceMs: number,
): Promise<number> {
  if (!acct.apiKeyV2) return 0; // No V2 key → can't resolve labels for this account.

  const rows = await db
    .select({
      shipmentId: shipments.id,
      trackingNumber: shipments.trackingNumber,
      labelUrl: shipments.labelUrl,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.voided, false),
        isNull(shipments.labelUrl),
        isNotNull(shipments.trackingNumber),
        gt(shipments.createdAt, new Date(sinceMs)),
      ),
    );
  if (!rows.length) return 0;

  const labelRecords: LabelUrlRecord[] = [];
  for (let page = 1; page <= MAX_LABEL_PAGES; page += 1) {
    const batch = await ssListRecentLabels(acct.apiKeyV2, { page, pageSize: LABEL_PAGE_SIZE });
    if (!batch.length) break;
    for (const rec of batch) labelRecords.push({ trackingNumber: rec.trackingNumber, labelUrl: rec.labelUrl });
    if (batch.length < LABEL_PAGE_SIZE) break; // last page
  }

  const updates = planShipmentLabelUrlBackfill(rows, labelRecords);
  let filled = 0;
  for (const u of updates) {
    // NULL-guarded fill — Per user override `unlock shipped data` on 2026-06-17.
    await db
      .update(shipments)
      .set({ labelUrl: u.labelUrl, updatedAt: new Date() })
      .where(and(eq(shipments.id, u.shipmentId), isNull(shipments.labelUrl)));
    filled += 1;
  }
  return filled;
}
