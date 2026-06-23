/**
 * PS-309 (Per user override unlock shipped data on 2026-06-23) — REAL execution test for the
 * voided-label display state. A shipped order whose only label is VOIDED must read as
 * "Voided label", NOT "Ext. Label", and its historical cost must not be shown as an active
 * charge (the #1298 bug: externally_shipped=true + raw externallyFulfilled=false + a single
 * voided shipment showed "Ext. Label" + a $9.50 active cost).
 *
 * The canonical classifier is backend-owned (resolveShippedLabelDisplayState); the list +
 * drawer consume the stamped field and must NOT re-derive it. This guard drives the real
 * classifier through the precedence cases AND pins the wiring across backend + both FE
 * surfaces. Offline/pure: no DB, no network, no void/postage/label/shipped mutation.
 */
import { readFileSync } from 'node:fs';
import { resolveShippedLabelDisplayState } from '../src/services/shipping-workflow/shipped-label-display-state';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// ── Classifier behaviour (the precedence) ──
check('#1298: voided-only + externally_shipped=true + externallyFulfilled=false -> voided_label (NOT external)',
  resolveShippedLabelDisplayState({ externallyShipped: true, externallyFulfilled: false, hasActiveShipment: false, hasVoidedShipment: true }) === 'voided_label');
check('an active (non-voided) shipment always wins -> active_label',
  resolveShippedLabelDisplayState({ externallyShipped: true, externallyFulfilled: null, hasActiveShipment: true, hasVoidedShipment: true }) === 'active_label');
check('a genuine marketplace label (externallyFulfilled=true) beats voided -> external_label',
  resolveShippedLabelDisplayState({ externallyShipped: false, externallyFulfilled: true, hasActiveShipment: false, hasVoidedShipment: true }) === 'external_label');
check('operator external-shipped override with no shipment -> external_label',
  resolveShippedLabelDisplayState({ externallyShipped: true, externallyFulfilled: null, hasActiveShipment: false, hasVoidedShipment: false }) === 'external_label');
check('shipped, no shipment, no external signal -> missing_shipment_sync',
  resolveShippedLabelDisplayState({ externallyShipped: false, externallyFulfilled: false, hasActiveShipment: false, hasVoidedShipment: false }) === 'missing_shipment_sync');

// ── Backend stamps the state on BOTH the list serializer + the detail payload ──
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
check('backend stamps shippedLabelDisplayState (list + detail) via the canonical owner',
  /resolveShippedLabelDisplayState\(/.test(ordersRoute) &&
  (ordersRoute.match(/shippedLabelDisplayState/g) ?? []).length >= 3);
check('shipped list query surfaces the voided flag for the display state',
  /coalesce\(voided, false\) as voided/.test(ordersRoute));

// ── FE consumes the backend verdict (no re-derivation; ARCHITECTURE.md) ──
const displayState = readFileSync('web/src/components/Views/orders-display-state.ts', 'utf8');
check('FE getShippedDataState reads the backend shippedLabelDisplayState field first',
  /getBackendShippedLabelDisplayState/.test(displayState) && /shippedLabelDisplayState/.test(displayState));
check("FE ShippedDataState includes 'voided' + exports getIsVoidedLabel",
  /'voided'/.test(displayState) && /export function getIsVoidedLabel/.test(displayState));

// ── FE shipped columns branch voided BEFORE ext, in all three columns ──
const cells = readFileSync('web/src/components/Views/orders/cells/order-cells.tsx', 'utf8');
check('shipped columns render renderVoidedLabelBadge()', /renderVoidedLabelBadge\(\)/.test(cells));
check('voided is checked before ext in all 3 shipped columns',
  (cells.match(/getIsVoidedLabel\(displayOrder\)/g) ?? []).length >= 3);

// ── Drawer flags voided + does not present the voided cost as active ──
const drawer = readFileSync('web/src/components/OrderDetailDrawer.tsx', 'utf8');
check('drawer flags voided label with a ⚠ banner',
  /isVoidedLabel/.test(drawer) && /data-shipped-label-state="voided"/.test(drawer));
// PS-309 Hermes re-audit fix: the ⚠ banner alone is not enough — every visible voided-label
// COST must be marked historical at the point it appears. Both the Cost Summary line AND the
// Configure-Shipment "Label Cost" Field must relabel to "Voided Label Cost" and strike/mute the
// value when voided, so the historical $ never reads as an active (green) charge.
check('drawer marks BOTH voided-cost lines historical (relabel + strike), not active green',
  (drawer.match(/'Voided Label Cost'/g) ?? []).length >= 2 &&
  /line-through/.test(drawer) &&
  // the green "active cost" colour is now conditional on NOT-voided
  /isVoidedLabel \? 'var\(--text3[^)]*\)' : 'var\(--green/.test(drawer));

if (failures > 0) {
  console.error(`\nPS-309 voided-label display guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-309 voided-label display guard passed.');
