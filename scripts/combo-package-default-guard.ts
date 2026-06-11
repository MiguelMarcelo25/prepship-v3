import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// PS-037 — combo package default wiring guard (no DB / no network).
//
// The pure combo-key rules are covered by package-combo-key-guard.ts. This
// guard pins the cross-layer contract so the feature can't silently regress:
//   - schema: client-scoped table, unique (clientId, comboKey).
//   - service: combo key DERIVED server-side from order items (never trusted
//     from the request body); upsert on conflict.
//   - route: save endpoint exists + is behind assertOrderEditable; detail
//     payload is enriched with comboPackageDefault.
//   - frontend: combo default is in the panel resolution chain, and the
//     multi-SKU save path NO LONGER stamps per-SKU inventory defaults
//     (the pollution bug) — it saves the combo default instead.
// ---------------------------------------------------------------------------

const schema = readFileSync('src/db/schema/client-combo-package-defaults.ts', 'utf8');
assert.match(schema, /clientId:\s*integer\(\)\s*\.notNull\(\)/, 'combo defaults must be client-scoped (clientId NOT NULL)');
assert.match(schema, /uniqueIndex\([^)]*\)\.on\(t\.clientId,\s*t\.comboKey\)/, 'must enforce uniqueness on (clientId, comboKey)');

const migration = readFileSync('drizzle/0035_client_combo_package_defaults.sql', 'utf8');
assert.match(migration, /CREATE TABLE IF NOT EXISTS "client_combo_package_defaults"/, 'migration must create the table idempotently');
assert.match(migration, /UNIQUE INDEX IF NOT EXISTS "client_combo_package_defaults_client_combo_idx"/, 'migration must create the (client_id, combo_key) unique index');
assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|ALTER COLUMN/i, 'migration must be non-destructive');

const service = readFileSync('src/services/combo-package-defaults.ts', 'utf8');
assert.match(service, /computeComboKey\(items\)/, 'service must derive the combo key from order items server-side');
assert.match(service, /from\(orderItems\)/, 'service must read canonical order_items to derive the key');
assert.match(service, /onConflictDoUpdate/, 'save must upsert on (clientId, comboKey)');
assert.match(
  service,
  /const \{ clientId, comboKey \} = await deriveOrderComboContext/,
  "save must scope by the order's server-derived clientId + comboKey",
);
assert.match(
  service,
  /target:\s*\[\s*clientComboPackageDefaults\.clientId,\s*clientComboPackageDefaults\.comboKey/,
  'upsert conflict target must be (clientId, comboKey)',
);

const routes = readFileSync('src/routes/orders.ts', 'utf8');
assert.match(routes, /\/save-combo-package-default/, 'save-combo-package-default route must exist');
assert.match(
  routes,
  /save-combo-package-default[\s\S]{0,1200}?assertOrderEditable\(c, id\)/,
  'save-combo route must be guarded by assertOrderEditable (RBAC + shipped/cancelled lockdown)',
);
assert.match(routes, /comboPackageDefault/, 'order detail payload must be enriched with comboPackageDefault');
// The key must come from the order, not the request body.
assert.match(routes, /saveComboPackageDefault\(\s*id\s*,/, 'route must pass the order id (server derives the combo key, not the client)');

const panelState = readFileSync('web/src/components/Views/orders-panel-state.ts', 'utf8');
assert.match(panelState, /export function getComboDefaultPackageId/, 'frontend must expose getComboDefaultPackageId resolver');

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
assert.match(ordersView, /getComboDefaultPackageId\(panelDetail, packages\)/, 'combo default must be in the panel package-resolution chain');
assert.match(ordersView, /saveComboPackageDefault\(/, 'multi-SKU save path must persist the combo default');
// The pollution bug: multi-SKU saves must NOT bulk-stamp per-SKU inventory defaults.
assert.doesNotMatch(
  ordersView,
  /bulkSetInventoryPackageDefault\(/,
  'multi-SKU package save must NOT stamp per-SKU inventory defaults (combo pollution regression)',
);

console.log('PASS combo package default wiring: client-scoped+unique schema, server-derived key, guarded route, enriched detail, resolution-chain wired, no per-SKU pollution (PS-037)');
