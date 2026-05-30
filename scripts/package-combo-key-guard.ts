import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeComboKey,
  normalizeComboItems,
  isMultiSkuCombo,
} from '../src/lib/package-combo';

// ---------------------------------------------------------------------------
// PS-037 — combo-key normalization guard. Pins every rule the ticket requires:
// casing/whitespace normalization, sort-order independence, duplicate-line
// summing, quantity sensitivity, adjustment/zero exclusion, multi-SKU detection.
// ---------------------------------------------------------------------------

// Basic two-SKU combo.
assert.equal(
  computeComboKey([{ sku: 'Booster-gel-001', quantity: 1 }, { sku: 'HU-10', quantity: 1 }]),
  'booster-gel-001:1|hu-10:1',
  'two-SKU combo must lowercase SKUs and join sorted sku:qty',
);

// Quantity sensitivity — different qty → different key.
assert.notEqual(
  computeComboKey([{ sku: 'Booster-gel-001', quantity: 2 }, { sku: 'HU-10', quantity: 1 }]),
  computeComboKey([{ sku: 'Booster-gel-001', quantity: 1 }, { sku: 'HU-10', quantity: 1 }]),
  'Booster x2 + Leeds x1 must be a DISTINCT key from Booster x1 + Leeds x1',
);
assert.equal(
  computeComboKey([{ sku: 'Booster-gel-001', quantity: 2 }, { sku: 'HU-10', quantity: 1 }]),
  'booster-gel-001:2|hu-10:1',
);

// Sort-order independence — reversed line order yields the same key.
assert.equal(
  computeComboKey([{ sku: 'HU-10', quantity: 1 }, { sku: 'Booster-gel-001', quantity: 1 }]),
  computeComboKey([{ sku: 'Booster-gel-001', quantity: 1 }, { sku: 'HU-10', quantity: 1 }]),
  'reversed item-line order must produce the same combo key',
);

// Whitespace + casing normalization.
assert.equal(
  computeComboKey([{ sku: '  booster-GEL-001 ', quantity: 1 }, { sku: 'hu-10', quantity: 1 }]),
  'booster-gel-001:1|hu-10:1',
  'SKUs must be trimmed + lowercased before keying',
);

// Duplicate lines for the same SKU are summed before matching.
assert.equal(
  computeComboKey([{ sku: 'Booster-gel-001', quantity: 1 }, { sku: 'Booster-gel-001', quantity: 1 }, { sku: 'HU-10', quantity: 1 }]),
  'booster-gel-001:2|hu-10:1',
  'duplicate SKU lines must be summed into one total qty',
);

// Adjustment lines and non-positive quantities are excluded.
assert.equal(
  computeComboKey([
    { sku: 'Booster-gel-001', quantity: 1 },
    { sku: 'HU-10', quantity: 1 },
    { sku: 'DISCOUNT', quantity: 1, adjustment: true },
    { sku: 'FREEBIE', quantity: 0 },
  ]),
  'booster-gel-001:1|hu-10:1',
  'adjustment lines and zero-qty lines must be excluded from the key',
);

// String quantities (as they arrive from numeric/jsonb payloads) coerce.
assert.equal(
  computeComboKey([{ sku: 'HU-10', quantity: '2' }]),
  'hu-10:2',
  'string quantities must coerce to integers',
);

// Empty / invalid → empty key (no default applicable).
assert.equal(computeComboKey([]), '');
assert.equal(computeComboKey(null), '');
assert.equal(computeComboKey([{ sku: '   ', quantity: 3 }]), '', 'blank SKU yields no key');

// normalizeComboItems shape.
assert.deepEqual(
  normalizeComboItems([{ sku: 'HU-10', quantity: 1 }, { sku: 'Booster-gel-001', quantity: 2 }]),
  [{ sku: 'booster-gel-001', qty: 2 }, { sku: 'hu-10', qty: 1 }],
);

// Multi-SKU detection.
assert.equal(isMultiSkuCombo([{ sku: 'a', quantity: 1 }, { sku: 'b', quantity: 1 }]), true);
assert.equal(isMultiSkuCombo([{ sku: 'a', quantity: 2 }]), false, 'single SKU (any qty) is not a multi-SKU combo');
assert.equal(isMultiSkuCombo([{ sku: 'a', quantity: 1 }, { sku: 'a', quantity: 1 }]), false, 'same SKU twice is still single-SKU');

// The four Hugrab examples must all be distinct keys.
const hug = [
  computeComboKey([{ sku: 'Booster-gel-001', quantity: 1 }, { sku: 'HU-10', quantity: 1 }]),
  computeComboKey([{ sku: 'Booster-gel-001', quantity: 2 }, { sku: 'HU-10', quantity: 1 }]),
  computeComboKey([{ sku: 'Booster-gel-001', quantity: 1 }, { sku: 'HU-10', quantity: 2 }]),
  computeComboKey([{ sku: 'Booster-gel-001', quantity: 2 }, { sku: 'HU-10', quantity: 2 }]),
];
assert.equal(new Set(hug).size, 4, 'the four Hugrab SKU+qty combinations must each be a distinct key');

console.log('PASS combo-key normalization (casing/whitespace, sort-independence, dup-summing, qty-sensitivity, adjustments, multi-SKU, Hugrab 4-combo distinctness)');
