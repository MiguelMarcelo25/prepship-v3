/**
 * PS-258 (slice C) — useTableDensityPreference extraction guard (STATIC).
 *
 * Pins the byte-identical extraction of the orders-table row-density preference
 * out of OrdersView.tsx into web/src/components/Views/orders-table-density-prefs.ts.
 * It is a React hook (cannot be invoked outside a renderer), so this guard is
 * purely static: it proves the module owns the state, is pure (react-only), keeps
 * the EXACT storage key + default + validation set, and that OrdersView delegates
 * to it instead of declaring the inline useState/useEffect cluster.
 *
 *   npx tsx scripts/ps-258-orders-table-density-prefs-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const MODULE_PATH = 'web/src/components/Views/orders-table-density-prefs.ts';
const ORDERS_VIEW_PATH = 'web/src/components/Views/OrdersView.tsx';
// PS-166 (Wave 4): the density segmented-control (the only `setTableDensity(...)`
// CALL site) moved VERBATIM into OrdersFilterToolbar.tsx. OrdersView still owns
// the hook + consumes `tableDensity` (the `density-${tableDensity}` table class)
// and wires `setTableDensity` into the toolbar as `onTableDensityChange`. State
// ownership is unchanged — only the toggle markup moved.
const TOOLBAR_PATH = 'web/src/components/Views/OrdersFilterToolbar.tsx';

const moduleSrc = readFileSync(MODULE_PATH, 'utf8');
const ordersView = readFileSync(ORDERS_VIEW_PATH, 'utf8');
const toolbar = readFileSync(TOOLBAR_PATH, 'utf8');

// ── the new module owns the hook + type, byte-identical behavior ──
check('module exports the useTableDensityPreference hook',
  /export function useTableDensityPreference\b/.test(moduleSrc));
check('module exports the TableDensity type',
  /export type TableDensity\b/.test(moduleSrc));
check('module preserves the EXACT storage key orders_table_density',
  /'orders_table_density'/.test(moduleSrc));
check('module preserves the default (cozy) + validation set (narrow|cozy|wide)',
  /return 'cozy'/.test(moduleSrc) &&
  /'narrow'|'cozy'|'wide'/.test(moduleSrc));
check('module is SSR-safe (typeof window === undefined guard)',
  /typeof window === 'undefined'/.test(moduleSrc));
check('module is NOT @ts-nocheck (genuinely type-checked)',
  !/@ts-nocheck/.test(moduleSrc));
check('module is PURE: imports only from react (no fetch/db/network/api)',
  /from 'react'/.test(moduleSrc) &&
  !/fetch\(/.test(moduleSrc) &&
  !/from ['"].*\/(db|lib\/api|v2-apiClient)['"]/.test(moduleSrc));

// ── OrdersView delegates to the hook, no longer the inline cluster ──
check('OrdersView imports useTableDensityPreference from ./orders-table-density-prefs',
  /import \{ useTableDensityPreference \} from '\.\/orders-table-density-prefs'/.test(ordersView));
check('OrdersView calls the hook (const [tableDensity, setTableDensity] = useTableDensityPreference())',
  /const \[tableDensity, setTableDensity\] = useTableDensityPreference\(\)/.test(ordersView));
check('OrdersView no longer declares the inline useState<TableDensity>',
  !/useState<TableDensity>/.test(ordersView));
check('OrdersView no longer inlines the orders_table_density localStorage access',
  !/localStorage\.(getItem|setItem)\('orders_table_density'/.test(ordersView));
check('OrdersView still consumes tableDensity (the density-${tableDensity} table class)',
  /tableDensity/.test(ordersView) && /density-\$\{tableDensity\}/.test(ordersView));
check('OrdersView wires setTableDensity into <OrdersFilterToolbar> (onTableDensityChange)',
  /onTableDensityChange:\s*setTableDensity/.test(ordersView));
check('OrdersFilterToolbar keeps the density toggle setter call site (onTableDensityChange(opt.key))',
  /onTableDensityChange\(opt\.key\)/.test(toolbar));

if (failures > 0) {
  console.error(`\nFAIL PS-258 orders-table-density-prefs guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-258 orders-table-density-prefs guard');
