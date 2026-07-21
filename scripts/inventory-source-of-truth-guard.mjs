import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const preparationMigration = readFileSync('drizzle/0073_inventory_quantity_sot.sql', 'utf8');
const cutoverMigration = readFileSync('drizzle/0074_inventory_quantity_cutover.sql', 'utf8');
const owner = readFileSync('src/services/inventory-stock-math.ts', 'utf8');
assert.equal(pkg.scripts?.['test:inventory-source-of-truth'], 'npm run test:ps-462-inventory-sot');
assert.doesNotMatch(preparationMigration, /DROP COLUMN/i);
assert.match(cutoverMigration, /PS439_INVENTORY_CUTOVER_BLOCKED/);
assert.match(cutoverMigration, /DROP COLUMN IF EXISTS stock_qty/);
assert.match(owner, /computeInventoryQuantityForIds/);
assert.doesNotMatch(owner, /effectiveStock|stockQty/);
console.log('PASS legacy inventory SOT guard delegates to PS-462 (renumbered from duplicate PS-439)');
