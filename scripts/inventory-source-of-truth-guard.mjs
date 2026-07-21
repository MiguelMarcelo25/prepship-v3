import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const migration = readFileSync('drizzle/0073_inventory_quantity_sot.sql', 'utf8');
const owner = readFileSync('src/services/inventory-stock-math.ts', 'utf8');
assert.equal(pkg.scripts?.['test:inventory-source-of-truth'], 'npm run test:ps-439-inventory-sot');
assert.match(migration, /DROP COLUMN IF EXISTS stock_qty/);
assert.match(owner, /computeInventoryQuantityForIds/);
assert.doesNotMatch(owner, /effectiveStock|stockQty/);
console.log('PASS legacy inventory SOT guard delegates to PS-439');
