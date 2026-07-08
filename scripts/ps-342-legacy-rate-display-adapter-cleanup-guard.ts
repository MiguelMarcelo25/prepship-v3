import { readFileSync } from 'node:fs';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`PS-342 legacy rate display adapter cleanup failed: ${message}`);
  }
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert(end > start, `missing ${endNeedle}`);
  return source.slice(start, end);
}

const shared = read('web/src/lib/v2-apiClient/shared.ts');
// Repointed (guard rot): the display-alias stamper moved out of routes/rates.ts into the
// shared owner src/services/rate-browser-display-fields.ts, money canonicalization e9762409
// moved the money-alias math into purchase-customer-rate-aliases.ts, and the /rates/browse
// producer (rate-browse-response-producer.ts) stamps every outgoing rate via
// stampRateBrowserDisplayAliases.
const displayFields = read('src/services/rate-browser-display-fields.ts');
const purchaseAliases = read('src/services/shipping-workflow/purchase-customer-rate-aliases.ts');
const browseProducer = read('src/services/rate-browse-response-producer.ts');
const packageJson = read('package.json');

const mapper = sliceBetween(
  shared,
  'export function translateRateToLegacyDisplayShape(',
  '\nexport async function fetchBlob(',
);

assert(
  /function stampRateBrowserDisplayAlias\(rate: Record<string, unknown>\)/.test(displayFields) &&
    browseProducer.includes('stampRateBrowserDisplayAliases(') &&
    purchaseAliases.includes('amount: selectedRateCost,') &&
    purchaseAliases.includes('shipmentCost: money.purchaseShipmentCost,') &&
    purchaseAliases.includes('otherCost: money.otherCost,'),
  'backend rate owners must own legacy display money aliases (display-fields stamper + purchase-customer money aliases, stamped by the /rates/browse producer)',
);

assert(
  packageJson.includes('"test:ps-342-legacy-rate-display-adapter-cleanup"'),
  'package must wire PS-342 cleanup guard',
);

assert(
  !/shipping_amount|original_amount|other_amount|confirmation_amount|insurance_amount/.test(mapper),
  'legacy rate display adapter must not read provider money fields',
);
assert(!/\bshipmentCost\s*=|\botherCost\s*=|amount:\s*shipmentCost\s*\+\s*otherCost/.test(mapper), 'adapter must not compute rate money aliases');
assert(
  mapper.includes('amount: obj.amount ?? null') &&
    mapper.includes('shipmentCost: obj.shipmentCost ?? null') &&
    mapper.includes('otherCost: obj.otherCost ?? null'),
  'adapter must pass through backend-stamped amount, shipmentCost, and otherCost aliases',
);
assert(
  mapper.includes('rateQuoteId: obj.rateQuoteId ?? null') &&
    mapper.includes('selectedRateKey: obj.selectedRateKey ?? null'),
  'adapter must preserve backend-issued proof refs as pass-through fields',
);
assert(
  mapper.includes('houseTuplePassThrough(obj)'),
  'adapter must preserve backend-issued house tuple fields as pass-through data',
);

console.log('PS-342 legacy rate display adapter cleanup guard passed');
