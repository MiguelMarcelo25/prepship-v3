import { readFileSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`[PS-067 guard] ${message}`);
    process.exit(1);
  }
}

const billingSource = read('src/services/billing.ts');
const diagnosticSource = read('scripts/diagnose-billing-external-fulfilled.ts');
const packageJson = JSON.parse(read('package.json'));

assert(
  !billingSource.includes('eq(orders.externallyShipped, false)') &&
    !billingSource.includes("coalesce(${orders.raw}->>'externallyFulfilled', 'false') <> 'true'") &&
    !billingSource.includes('and o.externally_shipped = false') &&
    !billingSource.includes("coalesce(o.raw->>'externallyFulfilled', 'false') <> 'true'"),
  'billing source queries must not exclude externally shipped/fulfilled orders from labor billing',
);
assert(
  billingSource.includes('billingShipDateSql') &&
    billingSource.includes('fulfilledAt') &&
    billingSource.includes('shipDate: row.billingShipDate'),
  'billing uses a safe shipment/fulfilled/order date fallback for external fulfilled orders',
);
assert(
  billingSource.includes("lineType: 'shipping_missing'") &&
    billingSource.includes('Missing shipping cost') &&
    billingSource.includes('shippingCostMissing'),
  'billing emits a safe zero-dollar missing-shipping diagnostic line without fabricating shipping cost',
);
assert(
  billingSource.includes("sum(case when b.line_type = 'shipping_missing'") &&
    billingSource.includes('missingShippingCostCount'),
  'billing summary surfaces missing shipping-cost counts',
);
// PS-402 (fulfillment-conflict read model) reformatted shippingCostMissing to a
// multi-line OR, and PS-373/377 (7f34f7bf) added the cancelled-no-charge gate to
// both emits; the invariants (flagged missing rows, canonical rate, no alias) hold.
assert(
  billingSource.includes('isMissingShippingLine') &&
    /shippingCostMissing:\s*\(isMissingShippingLine[\s\S]{0,120}!isCancelledNoChargeDetailRow/.test(billingSource) &&
    billingSource.includes('selectedRateCost: isShippingLine && !isCancelledNoChargeDetailRow ? selectedRateCost : null') &&
    !billingSource.includes('actualLabelCost'),
  'billing details safely identify missing shipping rows without exposing provider payloads',
);
assert(
  packageJson.scripts?.['test:ps-067-billing-external-fulfilled'] ===
    'node scripts/ps-067-billing-external-fulfilled-guard.mjs',
  'package exposes PS-067 billing external-fulfilled regression guard',
);
assert(
  packageJson.scripts?.['billing:external-fulfilled:diagnose'] ===
    'tsx scripts/diagnose-billing-external-fulfilled.ts',
  'package exposes read-only PS-067 billing diagnostic',
);
assert(
  diagnosticSource.includes('DRY RUN') &&
    diagnosticSource.includes('previouslyExcludedExternal') &&
    diagnosticSource.includes('includedWithMissingShippingCost') &&
    !diagnosticSource.includes('.update(') &&
    !diagnosticSource.includes('.delete('),
  'PS-067 diagnostic reports redacted counts and remains read-only',
);

console.log('PS-067 billing external fulfilled guard passed');
