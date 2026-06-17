// PS-286 — PURE planner for backfilling shipments.label_url from the authoritative
// ShipStation label record. No DB, no network.
//
// Source-of-truth note: shipments.label_url is the canonical home for the label PDF URL.
// The ShipStation shipment-list sync (src/services/shipment-sync.ts) never captured it,
// so synced shipped shipments landed with label_url = NULL and the Shipped view's
// "Send to Queue" greyed out. Both the sync forward-fix and the one-time backfill
// (scripts/ps-286-shipment-label-url-backfill.ts) delegate to this planner so the
// fill rule lives in exactly one tested place.
//
// Per user override `unlock shipped data` on 2026-06-17: the ONLY mutation this enables is
// setting a label_url that is currently NULL/blank. It NEVER overwrites an existing URL,
// fabricates one, or touches any other shipped/cancelled field.

/** A label URL is usable only if it is a non-blank string and not the '[object Object]'
 *  corruption sentinel — mirrors the FE getQueueableLabelUrl guard. */
export function isUsableLabelUrl(value: string | null | undefined): value is string {
  const trimmed = value?.trim();
  return !!trimmed && trimmed !== '[object Object]';
}

/** Normalize a tracking number for matching: trim + upper-case so v1/v2 formatting
 *  differences (whitespace, case) don't cause misses. Returns null for blanks. */
function normalizeTracking(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toUpperCase();
  return trimmed ? trimmed : null;
}

/** A shipment row that may need its label_url filled. */
export type ShipmentNeedingLabelUrl = {
  shipmentId: number;
  /** Carrier tracking number (shipments.tracking_number) — the cross-API match key.
   *  ShipStation's v1 shipment id (label_shipment_id) does NOT align with the v2
   *  /v2/labels shipment id, but the tracking number is identical across both. */
  trackingNumber: string | null;
  /** Current stored label_url (null/blank means it needs filling). */
  labelUrl: string | null;
};

/** A ShipStation label record (subset of ssListRecentLabels output). */
export type LabelUrlRecord = {
  trackingNumber: string | null;
  labelUrl: string | null;
};

/** The minimal write the backfill/sync would apply: set one shipment's label_url. */
export type ShipmentLabelUrlUpdate = {
  shipmentId: number;
  labelUrl: string;
};

/**
 * Plan the label_url fills: for each shipment that currently has NO usable label_url,
 * match its tracking number against the ShipStation label records and, if a usable URL
 * exists, produce an update. Idempotent and non-destructive — rows that already carry a
 * usable URL, lack a tracking number, or have no matching/usable record are skipped.
 */
export function planShipmentLabelUrlBackfill(
  rows: ShipmentNeedingLabelUrl[],
  labelRecords: LabelUrlRecord[],
): ShipmentLabelUrlUpdate[] {
  const urlByTracking = new Map<string, string>();
  for (const record of labelRecords) {
    const tracking = normalizeTracking(record.trackingNumber);
    if (!tracking || urlByTracking.has(tracking)) continue;
    if (isUsableLabelUrl(record.labelUrl)) {
      urlByTracking.set(tracking, record.labelUrl.trim());
    }
  }

  const updates: ShipmentLabelUrlUpdate[] = [];
  for (const row of rows) {
    if (isUsableLabelUrl(row.labelUrl)) continue; // already has one — never overwrite
    const tracking = normalizeTracking(row.trackingNumber);
    if (!tracking) continue;
    const labelUrl = urlByTracking.get(tracking);
    if (labelUrl) updates.push({ shipmentId: row.shipmentId, labelUrl });
  }
  return updates;
}
