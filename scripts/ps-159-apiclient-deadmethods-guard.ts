/**
 * PS-159 — v2-apiClient dead-method removal guard (absorbs PS-151).
 *
 * 19 apiClient OBJECT methods with zero callers (verified by member-access `.name` count === 0 across
 * web/src, with typecheck+build as the backstop) were removed. This guard asserts they stay removed and
 * uncalled. It also PINS two module-level functions that look removable but are NOT — clearCachedReads
 * and fetchDirectCarrierAccountRows are called internally as BARE functions (a `.name` member-access
 * scan misses those calls), so they must never be deleted by a future "dead apiClient method" pass.
 *
 * Offline / pure: readFileSync + readdir only.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'web/src/lib/v2-apiClient.ts';
const src = readFileSync(FILE, 'utf8');
// PS-167 (safe-partial) moved the module-level leaf helpers into
// ./v2-apiClient/shared.ts — the LIVE_MODULE_FNS pins read their new home.
const sharedSrc = readFileSync('web/src/lib/v2-apiClient/shared.ts', 'utf8');

const REMOVED = [
  'bulkSetInventoryPackageDefault', 'fetchClientDetail', 'fetchDashboardOrderSales', 'fetchInitData',
  'fetchInventoryDetail', 'fetchInventoryItemLedger', 'fetchLocationDetail', 'fetchLowStockPackages',
  'fetchOrderDetail', 'fetchOrderDims', 'fetchOrdersDailyCounts', 'fetchParentSkuDetail', 'fetchProducts',
  'fetchShipmentSyncStatus', 'saveProductDefaults', 'setToken', 'triggerShipmentSync', 'updateOrder',
  // PS-211/219: voidLabel was intentionally RE-ADDED as the universal label-void
  // method (live def v2-apiClient.ts; caller OrdersView.tsx). It is no longer a
  // dead method, so it is removed from the removed-methods list.
  // PS-179: FE strict persisters — the backend persists strict-recalc outcomes
  // inside /browse (PS-175/PS-178); their last FE callers were deleted there.
  'saveOrderDimsStrict', 'updateOrderBestRateSelectionStrict',
];
// Live module-level functions (bare-called internally) that must survive.
const LIVE_MODULE_FNS = ['clearCachedReads', 'fetchDirectCarrierAccountRows'];

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// gather all web/src ts/tsx
const files: string[] = [];
(function walk(d: string) {
  for (const e of readdirSync(d)) {
    const p = join(d, e); const st = statSync(p);
    if (st.isDirectory()) { if (e !== 'node_modules') walk(p); }
    else if (/\.(ts|tsx)$/.test(p)) files.push(p);
  }
})('web/src');

// ── (1) the 19 removed methods stay gone (not redefined as object methods) + uncalled (.name === 0) ──
const memberRe = (n: string) => new RegExp(`\\.${n}\\b`);
const objDefRe = (n: string) => new RegExp(`^  ${n}[ :(]`, 'm');
for (const n of REMOVED) {
  const redefined = objDefRe(n).test(src);
  const callers = files.filter((f) => memberRe(n).test(readFileSync(f, 'utf8')) && f.replace(/\\/g, '/') !== FILE).length;
  check(`removed apiClient.${n} stays gone (not redefined, 0 member-access callers)`,
    !redefined && callers === 0, redefined ? 'redefined' : `callers=${callers}`);
}

// ── (2) the two live module-level helpers survive (bare-called internally; do NOT delete) ──
for (const n of LIVE_MODULE_FNS) {
  check(`live module fn ${n}() retained (bare-called internally — not a dead method)`,
    new RegExp(`function ${n}\\b`).test(src) || new RegExp(`function ${n}\\b`).test(sharedSrc));
}

if (failures > 0) {
  console.error(`\nFAIL PS-159 apiClient dead-method guard (${failures} failing)`);
  process.exit(1);
}
console.log(`\nPASS PS-159 apiClient dead-method guard (${REMOVED.length} removed-and-uncalled; ${LIVE_MODULE_FNS.length} live helpers pinned)`);
