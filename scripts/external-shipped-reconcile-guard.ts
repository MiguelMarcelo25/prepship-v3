import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyExternalShipped, type ExternalShippedClass } from './reconcile-external-shipped-orders';

// PS — external-shipped reconcile guard. Pins the rule that distinguishes a
// genuinely marketplace-fulfilled order ("Ext. Label") from one that merely
// hasn't synced its shipment/fulfillment yet (#1010 / PS-039 → "Missing
// shipment sync"), plus the script's reversible, non-destructive safety.

function expect(input: Parameters<typeof classifyExternalShipped>[0], want: ExternalShippedClass, why: string) {
  assert.equal(classifyExternalShipped(input), want, why);
}

const base = { orderStatus: 'shipped', alreadyExternal: false, hasNonVoidedLocalShipment: false };

// Walmart/Amazon marketplace-shipped, nothing upstream → external.
expect(
  { ...base, upstream: { lookupFailed: false, hasShipment: false, hasFulfillment: false } },
  'external',
  'shipped with no upstream shipment AND no fulfillment must be classified external (Ext. Label)',
);

// #1010 / PS-039 shape: an upstream fulfillment exists → recoverable, NOT external.
expect(
  { ...base, upstream: { lookupFailed: false, hasShipment: false, hasFulfillment: true } },
  'recoverable',
  'an upstream fulfillment means missing-sync (recoverable), never external — must not re-break PS-036/PS-039',
);
// An upstream shipment exists → recoverable too.
expect(
  { ...base, upstream: { lookupFailed: false, hasShipment: true, hasFulfillment: false } },
  'recoverable',
  'an upstream shipment means missing-sync (recoverable), never external',
);

// Upstream lookup failed → retryable, never silently flipped.
expect(
  { ...base, upstream: { lookupFailed: true, hasShipment: false, hasFulfillment: false } },
  'lookup_failed',
  'a failed upstream lookup must not be treated as external',
);

// Skip guards.
expect(
  { orderStatus: 'awaiting_shipment', alreadyExternal: false, hasNonVoidedLocalShipment: false, upstream: { lookupFailed: false, hasShipment: false, hasFulfillment: false } },
  'skip_not_shipped',
  'awaiting orders are never considered (they do not surface the badge)',
);
// Cancelled orders ARE eligible (opt-in via --include-cancelled at the query
// level); a cancelled marketplace order with nothing upstream is external too.
expect(
  { orderStatus: 'cancelled', alreadyExternal: false, hasNonVoidedLocalShipment: false, upstream: { lookupFailed: false, hasShipment: false, hasFulfillment: false } },
  'external',
  'a cancelled order with no upstream shipment/fulfillment is also external',
);
expect(
  { ...base, alreadyExternal: true, upstream: { lookupFailed: false, hasShipment: false, hasFulfillment: false } },
  'skip_already_external',
  'orders already flagged external are left alone',
);
expect(
  { ...base, hasNonVoidedLocalShipment: true, upstream: { lookupFailed: false, hasShipment: false, hasFulfillment: false } },
  'skip_has_local_shipment',
  'orders with a real non-voided local shipment are not external',
);

console.log('PASS external-shipped classifier: external vs recoverable vs lookup_failed vs skips');

// Static safety asserts.
const script = readFileSync('scripts/reconcile-external-shipped-orders.ts', 'utf8');
assert.match(script, /const apply = hasFlag\('apply'\)/, 'must be dry-run by default (explicit --apply)');
assert.match(script, /externallyShipped: true/, 'apply must set the reversible externally_shipped flag');
assert.match(script, /marketplace_fulfilled/, 'apply must record the marketplace_fulfilled audit source');
assert.doesNotMatch(script, /db\.delete\(/, 'must never delete rows');
assert.doesNotMatch(script, /\.update\(shipments\)/, 'must never mutate shipment history');
assert.doesNotMatch(script, /buyLabel|purchaseLabel|createLabel|voidLabel|notifyMarketplace|notifySalesChannel/i, 'must never create/void labels or notify marketplaces');
assert.match(script, /coalesce\(s\.voided, false\) = false/, 'candidates must require NO non-voided local shipment');
assert.match(script, /const includeCancelled = hasFlag\('include-cancelled'\)/, 'cancelled orders must be opt-in via --include-cancelled (lockdown-safe default: shipped only)');
assert.match(script, /inArray\(orders\.orderStatus, statuses\)/, 'candidate query must scope by the resolved status set');
assert.match(script, /invokedDirectly/, 'main() must be guarded so the classifier can be imported without DB/network');

console.log('PASS external-shipped script is dry-run-default, reversible-flag-only, non-destructive');
