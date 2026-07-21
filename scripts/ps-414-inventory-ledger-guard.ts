/** PS-414 static source-of-truth guard. Offline; no DB or live operations. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');
const migration = read('drizzle/0061_inventory_ledger_effective_at.sql');
const schema = read('src/db/schema/inventory.ts');
const owner = read('src/services/inventory-movement.ts');
const inventoryRoute = read('src/routes/inventory.ts');
const fulfillment = read('src/services/fulfillment-deductions.ts');
const billing = read('src/services/billing.ts');
const reporting = read('src/services/reporting-metrics.ts');
const reconciliation = read('scripts/reconcile-inventory-stock.ts');
const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };

assert.match(migration, /ADD COLUMN IF NOT EXISTS "effective_at"/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS "idempotency_key"/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "inventory_ledger_idempotency_key_unq"/);
assert.doesNotMatch(migration, /\bUPDATE\b|\bDELETE\b|DROP COLUMN|ALTER COLUMN/i);

assert.match(schema, /effectiveAt: timestamp\('effective_at'/);
assert.match(schema, /idempotencyKey: text\('idempotency_key'\)/);
assert.match(owner, /stockQty: sql`\$\{inventory\.stockQty\} \+ \$\{move\.qty\}`/);
assert.match(owner, /insert\.onConflictDoNothing\(\)\.returning\(\)/);
assert.match(owner, /effectiveAt: move\.effectiveAt \?\? new Date\(\)/);
assert.doesNotMatch(owner, /createdAt:/);

assert.match(fulfillment, /INVENTORY_AUTO_DEDUCT/);
assert.match(fulfillment, /idempotencyKey: `inventory:ship:order:/);
assert.match(fulfillment, /applyInventoryMovementInTransaction\(tx/);
assert.match(fulfillment, /effectiveAt: input\.effectiveAt \?\?/);

assert.match(inventoryRoute, /omit\(\{ sku: true, stockQty: true \}\)/);
assert.match(inventoryRoute, /effectiveAt: movementDateFrom/);
assert.match(inventoryRoute, /coalesce\(l\.effective_at, l\.created_at\)/);
assert.match(billing, /coalesce\(effective_at, created_at\) as effective_at/);
assert.match(reporting, /min\(coalesce\(l\.effective_at, l\.created_at\)\) as effective_at/);
assert.match(reconciliation, /max\(coalesce\(l\.effective_at, l\.created_at\)\)::text as last_ledger_at/);
assert.equal(
  pkg.scripts?.['test:ps-414-inventory-ledger'],
  'tsx scripts/ps-414-inventory-ledger-guard.ts && tsx scripts/ps-414-inventory-ledger-integration.ts',
);

console.log('PASS PS-414 inventory ledger guard');
