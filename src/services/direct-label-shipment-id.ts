/**
 * PS-243 — local shipment-id namespace for DIRECT (non-ShipStation) carrier labels.
 *
 * shipments.labelShipmentId is integer() and MEANS "ShipStation shipment id"
 * (positive int4). A direct provider (Walmart Shipping, FedEx, EasyPost) can
 * return a numeric shipment id far above int4 max (e.g. Walmart 382006979895),
 * which overflows the column at INSERT, AND — even when it fits — could collide
 * with a real ShipStation id in void/return/sync lookups that match labelShipmentId.
 *
 * So a direct label's LOCAL shipment id is ALWAYS a synthetic value from
 * generateFakeShipmentId() — negative by construction, which keeps it in a
 * reserved, collision-proof namespace (ShipStation ids are positive) and always
 * within int4. The provider's real id is preserved in labelId (text), which is
 * what direct void/return dispatch keys off (label-void-policy: source + labelId).
 * Do NOT widen labelShipmentId to bigint — a non-SS id there could be sent to
 * ShipStation's void API.
 */
import { generateFakeShipmentId } from './mock-label-generator';

export function resolveDirectLabelShipmentRef(args: {
  /** The provider's shipment id (stringified), if any. */
  providerShipmentId: string | null;
  /** The provider's label id (stringified), if any. */
  providerLabelId: string | null;
  /** Last-resort label id, e.g. `${provider}-${tracking}`. */
  fallbackLabelId: string;
}): { shipmentId: number; labelId: string } {
  return {
    // Always synthetic (negative, reserved, int4-safe) — never provider-derived.
    shipmentId: generateFakeShipmentId(),
    labelId: String(args.providerLabelId ?? args.providerShipmentId ?? args.fallbackLabelId),
  };
}
