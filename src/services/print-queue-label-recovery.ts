// PS-288 — pure matcher for recovering an ALREADY-purchased ShipStation label whose local
// shipments.label_url went NULL (shipment-sync never wrote it; ~72% of synced shipped shipments,
// which greys out "Send to Queue"). Given the recent ShipStation labels and a local shipment's
// identity, return the label_url that belongs to it so it can be backfilled — WITHOUT buying new
// postage. Match by tracking number first (unambiguous), then by ShipStation label_id (the local
// labelShipmentId is a label_id), then by shipment_id as a fallback. Returns null when nothing
// matches or the matched record has no downloadable url — never a guess. Pure: no IO, no DB.

export type RecoverableLabelRecord = {
  labelId: string | null;
  shipmentId: number | null;
  trackingNumber: string | null;
  labelUrl: string | null;
  // PS-288 (continuation) — the ALREADY-purchased label's own format ('pdf'|'png'|'zpl'), so the
  // backfill can stamp the real format instead of the stale local row default. Optional: a record
  // that doesn't carry one falls back to the row format at the backfill site.
  labelFormat?: string | null;
};

// Return the matched recoverable label RECORD (url + the recovered format), matching by tracking
// number first (unambiguous), then by ShipStation label_id, then by shipment_id. Only a record WITH
// a downloadable url qualifies — never a guess. Pure: no IO, no DB.
export function matchRecoverableLabel(
  labels: RecoverableLabelRecord[],
  key: { trackingNumber: string | null; labelShipmentId: number | null },
): RecoverableLabelRecord | null {
  const tracking = key.trackingNumber?.trim() || null;
  if (tracking) {
    const byTracking = labels.find((l) => (l.trackingNumber?.trim() || null) === tracking && l.labelUrl);
    if (byTracking?.labelUrl) return byTracking;
  }
  const id = key.labelShipmentId != null ? String(key.labelShipmentId) : null;
  if (id) {
    const byLabelId = labels.find((l) => (l.labelId?.trim() || null) === id && l.labelUrl);
    if (byLabelId?.labelUrl) return byLabelId;
    const byShipmentId = labels.find((l) => l.shipmentId != null && String(l.shipmentId) === id && l.labelUrl);
    if (byShipmentId?.labelUrl) return byShipmentId;
  }
  return null;
}

// Thin url-only wrapper over matchRecoverableLabel — preserved for existing callers/tests.
export function matchRecoverableLabelUrl(
  labels: RecoverableLabelRecord[],
  key: { trackingNumber: string | null; labelShipmentId: number | null },
): string | null {
  return matchRecoverableLabel(labels, key)?.labelUrl ?? null;
}
