// PS-309 (Per user override unlock shipped data on 2026-06-23): the canonical,
// backend-owned shipped-label DISPLAY state. The Orders → Shipped list AND the order
// detail drawer both read THIS one field — the frontend must NOT re-derive it
// (ARCHITECTURE.md: the backend owns shipped-label truth; UI is a thin consumer).
//
// The #1298 bug: a HUGRAB order with externally_shipped=true, raw ShipStation
// externallyFulfilled=false, and ONLY a voided shipment row was shown as "Ext. Label"
// with a $9.50 cost. The shipped-list query excluded voided rows, so the FE saw no local
// shipment and fell back to the externally_shipped flag → "external label". This owner
// makes VOIDED evidence win over that flag, so a voided label reads as "Voided label" and
// its historical cost is never presented as an active label cost.
//
// This is a READ/display classifier only — it performs no void, no postage, no label, and
// no shipped/cancelled mutation.

export type ShippedLabelDisplayState =
  | 'active_label' //          a non-voided shipment with label data exists — the active truth
  | 'voided_label' //          the chosen shipment label is voided with no active replacement
  | 'external_label' //        a true marketplace/client external label (explicit external truth)
  | 'missing_shipment_sync'; // shipped, no active shipment, and NOT a true external label

export type ShippedLabelDisplayInput = {
  // orders.externally_shipped — the operator/PrepShip "shipped outside PrepShip" override.
  externallyShipped: boolean;
  // raw ShipStation externallyFulfilled — the genuine marketplace/client-label signal.
  externallyFulfilled: boolean | null;
  // a NON-voided shipment row exists for this order (the active label truth).
  hasActiveShipment: boolean;
  // the chosen/only shipment row for this order is voided.
  hasVoidedShipment: boolean;
};

/**
 * Resolve the shipped-label display state. Callers gate on order_status === 'shipped'
 * before stamping (awaiting/cancelled are classified elsewhere). Precedence:
 *   1. active shipment            -> active_label   (a real non-voided label wins, always)
 *   2. voided + not truly external -> voided_label  (#1298: beats the externally_shipped flag)
 *   3. explicit external signal    -> external_label (raw externallyFulfilled, or the override)
 *   4. otherwise                   -> missing_shipment_sync
 */
export function resolveShippedLabelDisplayState(
  input: ShippedLabelDisplayInput,
): ShippedLabelDisplayState {
  if (input.hasActiveShipment) return 'active_label';
  // A voided label with no active replacement reads as VOIDED — and this beats the
  // externally_shipped override UNLESS ShipStation itself reports a genuine external
  // fulfilment (externallyFulfilled === true), which is a real marketplace/client label.
  if (input.hasVoidedShipment && input.externallyFulfilled !== true) return 'voided_label';
  if (input.externallyFulfilled === true || input.externallyShipped) return 'external_label';
  return 'missing_shipment_sync';
}
