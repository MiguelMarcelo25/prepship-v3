import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const comboService = readFileSync('src/services/combo-package-defaults.ts', 'utf8');
const comboKey = readFileSync('src/lib/package-combo.ts', 'utf8');

assert.match(
  comboKey,
  /bySku\.set\(sku,\s*\(bySku\.get\(sku\) \?\? 0\) \+ qty\)/,
  'combo key must collapse duplicate SKU lines into a summed quantity',
);
assert.match(
  comboService,
  /computeComboKey\(items\)/,
  'backend service must derive the combo key from real order items',
);
assert.match(
  comboService,
  /target:\s*\[\s*clientComboPackageDefaults\.clientId,\s*clientComboPackageDefaults\.comboKey/,
  'combo defaults must upsert by exact client + normalized SKU quantity key',
);
assert.match(
  apiClient,
  /saveComboPackageDefault\(/,
  'frontend API must expose the combo default save endpoint',
);
assert.doesNotMatch(
  ordersView,
  /Multi-SKU order - edit each product's defaults in the Products tab/,
  'manual save flow must not show the old multi-SKU blocker',
);
assert.match(
  ordersView,
  /savePanelComboDefaults\(/,
  'OrdersView must route multi-SKU manual saves through a dedicated combo-default path',
);
assert.match(
  ordersView,
  /Saved package defaults for this SKU combination/,
  'multi-SKU manual save must show a clear combo-default success message',
);
assert.match(
  ordersView,
  /Package\/dims are incomplete for this SKU combination/,
  'multi-SKU manual save must show an actionable missing package/dims error',
);
assert.doesNotMatch(
  ordersView,
  /if \(!target\)[\s\S]{0,800}?saveProductDefaultsV2/,
  'multi-SKU save path must not fall through to per-SKU product defaults',
);

console.log('PASS PS-060 combo save defaults guard');
