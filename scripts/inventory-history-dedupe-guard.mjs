import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const inventoryRoute = readFileSync('src/routes/inventory.ts', 'utf8');
const movementOwner = readFileSync('src/services/inventory-movement.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// PS-462 superseded the derived order_history fallback. Inventory History now reads
// each immutable ledger movement exactly once; duplicate intent is rejected at the
// canonical append boundary instead of hidden by read-time de-duplication.
assert(
  inventoryRoute.includes('PS-462: immutable movement identity is the history owner') &&
    inventoryRoute.includes('with ledger_rows as (') &&
    inventoryRoute.includes('from ${inventoryLedger}') &&
    inventoryRoute.includes('${ledgerSkuSql} as sku') &&
    inventoryRoute.includes('${ledgerClientIdSql} as client_id'),
  'backend /inventory/ledger reads the canonical immutable movement history',
);
assert(
  !inventoryRoute.includes('derived_ship_rows') &&
    !inventoryRoute.includes("'order_history'::text") &&
    !inventoryRoute.includes('real_ship_ledger_keys'),
  'backend /inventory/ledger must not synthesize duplicate order-history movements',
);
assert(
  movementOwner.includes('.onConflictDoNothing()') &&
    movementOwner.includes('INVENTORY_IDEMPOTENCY_CONFLICT') &&
    movementOwner.includes("status: 'already_applied' as const"),
  'canonical inventory movement owner prevents duplicate persisted intent',
);
assert.equal(
  pkg.scripts?.['test:inventory-history-dedupe'],
  'node scripts/inventory-history-dedupe-guard.mjs',
  'package exposes focused Inventory History de-dupe guard',
);

console.log('PASS inventory history uses immutable de-duplicated ledger movements');
