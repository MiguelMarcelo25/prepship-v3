import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planFulfillmentBackfill,
  type FulfillmentBackfillAction,
} from './backfill-shipstation-fulfillments';

// ---------------------------------------------------------------------------
// PS-039 — ShipStation fulfillment backfill guard.
//
// Pins the failure pattern from order #1010: a shipped order whose only label
// was voided and which was then "Marked as Shipped" (a /fulfillments record,
// not a /shipments label) must be recoverable into a non-voided local shipment
// row so the Orders grid stops showing "Missing shipment sync" / false
// "Ext. Label". Also pins the backfill's insert-only safety.
// ---------------------------------------------------------------------------

function expect(input: Parameters<typeof planFulfillmentBackfill>[0], want: FulfillmentBackfillAction, why: string) {
  assert.equal(planFulfillmentBackfill(input).action, want, why);
}

const order = { id: 1138616, clientId: 4, orderNumber: '1010' };

// #1010 reproduction: voided label only, active manual fulfillment upstream → insert.
expect(
  {
    localOrder: order,
    activeLocalShipments: [], // the only local shipment is voided → excluded from "active"
    fulfillments: [{ fulfillmentId: 18215558, trackingNumber: '1ZGG63810315490872', carrierCode: 'UPS', voided: false }],
  },
  'insert',
  'shipped order with only a voided label + an active upstream fulfillment must insert the fulfillment shipment',
);

// Idempotent: a non-voided local shipment already carries that tracking → skip.
expect(
  {
    localOrder: order,
    activeLocalShipments: [{ trackingNumber: '1ZGG63810315490872' }],
    fulfillments: [{ fulfillmentId: 18215558, trackingNumber: '1ZGG63810315490872', carrierCode: 'UPS', voided: false }],
  },
  'skip_already_linked',
  'must be idempotent — never insert a duplicate when the tracking is already linked',
);

// Order already has a real (different) non-voided label → that's authoritative, skip.
expect(
  {
    localOrder: order,
    activeLocalShipments: [{ trackingNumber: '1Zdifferent' }],
    fulfillments: [{ fulfillmentId: 18215558, trackingNumber: '1ZGG63810315490872', carrierCode: 'UPS', voided: false }],
  },
  'skip_has_active_shipment',
  'must not add a manual-fulfillment row when the order already has an authoritative non-voided label',
);

// No active fulfillment upstream (all voided / no tracking) → nothing to do.
expect(
  {
    localOrder: order,
    activeLocalShipments: [],
    fulfillments: [{ fulfillmentId: 1, trackingNumber: '1Zx', carrierCode: 'UPS', voided: true }],
  },
  'skip_no_active_fulfillment',
  'a voided-only fulfillment set must not be inserted',
);

// No local order for the number → skip.
expect(
  { localOrder: null, activeLocalShipments: [], fulfillments: [{ fulfillmentId: 1, trackingNumber: '1Zx', carrierCode: 'UPS', voided: false }] },
  'skip_no_order',
  'no local order means nothing to attach to',
);

console.log('PASS fulfillment backfill planner covers insert / idempotent / authoritative-label / voided / no-order');

// ---------------------------------------------------------------------------
// Static safety asserts on the backfill script.
// ---------------------------------------------------------------------------
const script = readFileSync('scripts/backfill-shipstation-fulfillments.ts', 'utf8');
assert.match(script, /const apply = hasFlag\('apply'\)/, 'backfill must be dry-run by default (explicit --apply)');
assert.match(script, /source: 'shipstation_fulfillment'/, "inserted rows must be tagged source 'shipstation_fulfillment'");
assert.match(script, /cost: null/, 'manual fulfillment rows must carry null cost (the voided label cost is not reused)');
assert.doesNotMatch(script, /db\.update\(shipments\)/, 'backfill must be INSERT-ONLY — never update existing shipment rows');
assert.doesNotMatch(script, /db\.delete\(shipments\)/, 'backfill must never delete shipment rows');
assert.doesNotMatch(script, /buyLabel|purchaseLabel|createLabel|voidLabel|notifyMarketplace|notifySalesChannel/i, 'backfill must never create/void labels or notify marketplaces');
assert.match(script, /invokedDirectly/, 'main() must be guarded so the planner can be imported without DB/network');

// ---------------------------------------------------------------------------
// Display contract (PS-036): a row with a tracking number must classify as
// local shipment data — NOT "missing" and NOT false "Ext. Label". This is what
// makes the inserted fulfillment row fix the #1010 display.
// ---------------------------------------------------------------------------
// PS-166 Wave 2a re-anchor: hasLocalShipmentData moved VERBATIM to the
// orders-display-state module (PS-036 classification unchanged).
const displayState = readFileSync('web/src/components/Views/orders-display-state.ts', 'utf8');
assert.match(
  displayState,
  /hasLocalShipmentData[\s\S]*order\.label\?\.trackingNumber/,
  'hasLocalShipmentData must treat a tracking number as real local shipment data so a recovered fulfillment row renders as shipped, not missing/external',
);

console.log('PASS backfill script is dry-run-default + insert-only, and the tracking-number display contract holds (PS-039)');
