/**
 * PS-082 Guard — combo package defaults may fan out to matching orders, but
 * only to mutable awaiting-shipment rows.
 *
 * Read-only static guard: no DB, no network, no order mutations.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const service = readFileSync('src/services/combo-package-defaults.ts', 'utf8');
const productsRoute = readFileSync('src/routes/products.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');

assert.match(
  service,
  /function applyComboPackageDefaultToMatchingMutableOrders\(/,
  'combo default save must use a dedicated matching-order fanout helper',
);
assert.match(
  service,
  /eq\(orders\.orderStatus,\s*'awaiting_shipment'\)/,
  'matching-order fanout must be restricted to awaiting_shipment orders',
);
assert.doesNotMatch(
  service,
  /not\(eq\(orders\.orderStatus,\s*'shipped'\)\)|orders\.orderStatus\s*!==\s*'shipped'/,
  'matching-order fanout must not use a shipped-only exclusion; cancelled/other immutable states must also stay untouched',
);
assert.match(
  service,
  /computeComboKey\(items\)\s*!==\s*comboKey/,
  'matching-order fanout must compare each candidate using the backend-derived combo key',
);
// PS-121 re-anchor: the fanout now builds a `set` object (dims + weight, plus a conditional
// stale-rate invalidation) and persists it via an insert(orderOverrides) upsert. Assert both
// halves (order-agnostic) — the protection (dims+weight written through order_overrides) holds.
assert.match(
  service,
  /rateDimsL:[\s\S]*rateDimsW:[\s\S]*rateDimsH:[\s\S]*rateWeightOz/,
  'matching-order fanout must set dims and weight',
);
assert.match(
  service,
  /insert\(orderOverrides\)[\s\S]*onConflictDoUpdate/,
  'matching-order fanout must persist dims/weight through an order_overrides upsert',
);
assert.match(
  service,
  /selectedPackageId/,
  'matching-order fanout must also align the selected package id for mutable matching orders',
);
assert.match(
  service,
  /appliedMutableOrderCount/,
  'save result must report how many mutable matching orders were updated',
);
assert.match(
  packageJson,
  /"test:ps-082-combo-default-unshipped-only":\s*"tsx scripts\/ps-082-combo-default-unshipped-only-guard\.ts"/,
  'package script must expose the PS-082 unshipped-only guard',
);
assert.match(
  productsRoute,
  /function applySingleSkuDefaultsToMatchingMutableOrders\(/,
  'single-SKU default save must use a dedicated matching-order fanout helper',
);
assert.match(
  productsRoute,
  /eq\(orders\.orderStatus,\s*'awaiting_shipment'\)/,
  'single-SKU fanout must be restricted to awaiting_shipment orders',
);
assert.match(
  productsRoute,
  /normalizeComboItems\(/,
  'single-SKU fanout must derive each candidate SKU/qty from normalized order items',
);
// PS-121 re-anchor: same `set`-object + insert(orderOverrides) upsert structure as the combo path.
assert.match(
  productsRoute,
  /rateDimsL:[\s\S]*rateDimsW:[\s\S]*rateDimsH:[\s\S]*rateWeightOz/,
  'single-SKU fanout must set dims and total order weight',
);
assert.match(
  productsRoute,
  /insert\(orderOverrides\)[\s\S]*onConflictDoUpdate/,
  'single-SKU fanout must persist dims/weight through an order_overrides upsert',
);
assert.doesNotMatch(
  productsRoute,
  /not\(eq\(orders\.orderStatus,\s*'shipped'\)\)|orders\.orderStatus\s*!==\s*'shipped'/,
  'single-SKU fanout must not use a shipped-only exclusion; cancelled/other immutable states must also stay untouched',
);

console.log('PASS PS-082 combo default unshipped-only guard');
