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
};

export function matchRecoverableLabelUrl(
  labels: RecoverableLabelRecord[],
  key: { trackingNumber: string | null; labelShipmentId: number | null },
): string | null {
  const tracking = key.trackingNumber?.trim() || null;
  if (tracking) {
    const byTracking = labels.find((l) => (l.trackingNumber?.trim() || null) === tracking && l.labelUrl);
    if (byTracking?.labelUrl) return byTracking.labelUrl;
  }
  const id = key.labelShipmentId != null ? String(key.labelShipmentId) : null;
  if (id) {
    const byLabelId = labels.find((l) => (l.labelId?.trim() || null) === id && l.labelUrl);
    if (byLabelId?.labelUrl) return byLabelId.labelUrl;
    const byShipmentId = labels.find((l) => l.shipmentId != null && String(l.shipmentId) === id && l.labelUrl);
    if (byShipmentId?.labelUrl) return byShipmentId.labelUrl;
  }
  return null;
}
