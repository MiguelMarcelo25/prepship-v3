import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

const migration = source('drizzle/0078_order_hazmat_declarations.sql');
for (const relation of [
  'order_hazmat_declarations',
  'order_hazmat_materials',
  'shipment_hazmat_snapshots',
]) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${relation}\\b`, 'i'));
}
assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE\s+FROM|TRUNCATE)\s+public\.(?:orders|shipments)\b/i);
assert.doesNotMatch(migration, /\bALTER\s+TABLE\s+public\.(?:orders|shipments)\b/i);
assert.match(migration, /BEFORE UPDATE OR DELETE ON public\.shipment_hazmat_snapshots/i);
assert.match(migration, /BEFORE TRUNCATE ON public\.shipment_hazmat_snapshots/i);
assert.match(migration, /shipment_hazmat_snapshots is append-only/i);
assert.match(migration, /ON DELETE RESTRICT/i);
assert.match(migration, /does not backfill or mutate orders, shipments, or historical labels/i);

const env = source('src/lib/env.ts');
for (const flag of [
  'HAZMAT_READ_ENABLED',
  'HAZMAT_WRITE_ENABLED',
  'HAZMAT_RATE_ENABLED',
  'HAZMAT_PURCHASE_ENABLED',
  'HAZMAT_USPS_ENABLED',
  'HAZMAT_UPS_SHIPSTATION_ENABLED',
  'HAZMAT_UPS_DIRECT_ENABLED',
  'HAZMAT_WALMART_ENABLED',
]) {
  assert.match(env, new RegExp(`${flag}: booleanFlag\\(false\\)`), `${flag} must default off`);
}
assert.match(env, /HAZMAT_CANARY_CLIENT_IDS: z\.string\(\)\.default\(''\)/);

const readiness = source('src/services/runtime-schema-readiness.ts');
for (const requirement of [
  'order_hazmat_declarations',
  'order_hazmat_materials',
  'shipment_hazmat_snapshots',
  'shipment_hazmat_snapshots_block_mutations',
  'shipment_hazmat_snapshots_no_update_delete',
  'shipment_hazmat_snapshots_no_truncate',
  'shipment_hazmat_snapshots_active_chk',
  'shipment_hazmat_snapshots_profile_chk',
  '0078_order_hazmat_declarations.sql',
]) {
  assert.match(readiness, new RegExp(requirement));
}

const auth = source('src/middleware/auth.ts');
const operatorPermissions = auth.match(/operator:\s*\[([\s\S]*?)\n\s*\],\s*\n\s*warehouse:/)?.[1] ?? '';
const warehousePermissions = auth.match(/warehouse:\s*\[([\s\S]*?)\n\s*\],\s*\n\s*client_user:/)?.[1] ?? '';
assert.match(operatorPermissions, /'hazmat:write'/);
assert.doesNotMatch(warehousePermissions, /'hazmat:write'/);

const routes = source('src/routes/order-hazmat.ts');
assert.match(routes, /requireInternalPermission\('hazmat:write'\)/);
assert.match(routes, /requireInternalPermission\('rates:quote'\)/);
assert.match(source('src/main.ts'), /app\.route\('\/orders', orderHazmatRoute\)/);
const rateRoutes = source('src/routes/rates.ts');
assert.match(rateRoutes, /error instanceof HazmatShippingError/);
assert.match(rateRoutes, /rate\.browse\.hazmat_rejected/);

const labels = source('src/services/labels.ts');
assert.match(labels, /Per user override unlock shipped data on 2026-07-25/);
assert.match(labels, /shipmentHazmatSnapshots/);
const queue = source('src/services/print-queue.ts');
assert.match(queue, /Per user override unlock shipped data on 2026-07-25/);
assert.doesNotMatch(queue, /(?:update|delete)\(shipmentHazmatSnapshots\)/);
assert.match(source('web/src/components/Views/OrdersHazmatDeclaration.tsx'), /Per user override unlock shipped data on 2026-07-25/);

const browserProof = source('web/e2e/orders-ps465-hazmat.spec.js');
assert.match(browserProof, /Every request is intercepted/);
assert.match(browserProof, /Saved\. The previous rate was cleared; re-rate before buying a label\./);
assert.match(browserProof, /Hazmat declaration changed in another session/);
assert.match(browserProof, /Shipped hazmat snapshot is immutable\./);
assert.match(browserProof, /Immutable hazmat snapshot revision/);
assert.match(
  source('package.json'),
  /"test:ps-465-hazmat:browser": "playwright test web\/e2e\/orders-ps465-hazmat\.spec\.js --reporter=line"/,
);

console.log('PS-465 additive migration, rollout, permission, and lockdown guard passed');
