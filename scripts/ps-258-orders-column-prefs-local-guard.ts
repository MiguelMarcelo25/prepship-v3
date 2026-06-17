/**
 * PS-258 — localStorage column-prefs helpers extraction guard (BEHAVIORAL + STATIC).
 *
 * Imports the REAL helpers extracted VERBATIM out of OrdersView.tsx
 * (web/src/components/Views/orders-column-prefs-local.ts) and pins their behavior
 * so the extraction is proven importable, side-effect-bounded, and byte-identical.
 *
 *  - readLocalColumnPrefs(): SSR-safe (returns null when window is undefined);
 *    round-trips a written value; returns null on missing/corrupt JSON.
 *  - writeLocalColumnPrefs(prefs): SSR-safe no-op when window is undefined;
 *    swallows a throwing setItem (quota) without raising.
 *  - COLUMN_PREFS_LOCAL_STORAGE_KEY: the stable storage key both helpers use.
 *
 * STATIC pins: OrdersView imports both helpers from the new module and no longer
 * defines either local nor the storage-key const; the new module exports both
 * functions + the const and is NOT @ts-nocheck; package.json wires
 * test:ps-258-orders-column-prefs-local.
 *
 *   npx tsx scripts/ps-258-orders-column-prefs-local-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const MODULE_PATH = 'web/src/components/Views/orders-column-prefs-local.ts';
const ORDERS_VIEW_PATH = 'web/src/components/Views/OrdersView.tsx';

// ── A fresh in-memory localStorage shim, installed on a fresh `window` so the
//    module's `typeof window !== 'undefined'` branch is exercised. ──
type Store = Record<string, string>;
function installWindow(localStorage: Storage): void {
  (globalThis as { window?: unknown }).window = { localStorage };
}
function uninstallWindow(): void {
  delete (globalThis as { window?: unknown }).window;
}
function memoryStorage(): { storage: Storage; raw: Store } {
  const raw: Store = {};
  const storage = {
    getItem: (k: string) => (k in raw ? raw[k] : null),
    setItem: (k: string, v: string) => { raw[k] = String(v); },
    removeItem: (k: string) => { delete raw[k]; },
    clear: () => { for (const k of Object.keys(raw)) delete raw[k]; },
    key: (i: number) => Object.keys(raw)[i] ?? null,
    get length() { return Object.keys(raw).length; },
  } as Storage;
  return { storage, raw };
}

async function main(): Promise<void> {
  // ── SSR-safe path: no window → read returns null, write is a no-op (no throw) ──
  uninstallWindow();
  const mod = await import('../web/src/components/Views/orders-column-prefs-local');
  const { readLocalColumnPrefs, writeLocalColumnPrefs, COLUMN_PREFS_LOCAL_STORAGE_KEY } = mod;

  check('COLUMN_PREFS_LOCAL_STORAGE_KEY is the stable orders key',
    COLUMN_PREFS_LOCAL_STORAGE_KEY === 'prepship.orders.columnPrefs');
  check('SSR-safe: readLocalColumnPrefs() returns null when window is undefined',
    readLocalColumnPrefs() === null);
  let ssrWriteThrew = false;
  try { writeLocalColumnPrefs({ order: ['a'] }); } catch { ssrWriteThrew = true; }
  check('SSR-safe: writeLocalColumnPrefs() is a no-op (does not throw) without window',
    !ssrWriteThrew);

  // ── Round-trip: write then read returns an equal-by-value ColumnPrefs ──
  const mem = memoryStorage();
  installWindow(mem.storage);
  const prefs = { order: ['date', 'client'], hidden: ['age'], widths: { date: 120 }, version: 2 };
  writeLocalColumnPrefs(prefs);
  check('write persists JSON under COLUMN_PREFS_LOCAL_STORAGE_KEY',
    mem.raw[COLUMN_PREFS_LOCAL_STORAGE_KEY] === JSON.stringify(prefs));
  const readBack = readLocalColumnPrefs();
  check('round-trip: read returns a structurally-equal ColumnPrefs',
    JSON.stringify(readBack) === JSON.stringify(prefs));

  // ── Missing key → null ──
  mem.storage.clear();
  check('read returns null when nothing is stored',
    readLocalColumnPrefs() === null);

  // ── Corrupt JSON → null (the try/catch in read) ──
  mem.raw[COLUMN_PREFS_LOCAL_STORAGE_KEY] = '{not valid json';
  check('read returns null on corrupt JSON (does not throw)',
    readLocalColumnPrefs() === null);

  // ── write swallows a throwing setItem (quota) ──
  const throwingStorage = {
    getItem: () => null,
    setItem: () => { throw new DOMException('QuotaExceededError'); },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  } as unknown as Storage;
  installWindow(throwingStorage);
  let quotaThrew = false;
  try { writeLocalColumnPrefs(prefs); } catch { quotaThrew = true; }
  check('write swallows a quota/setItem error (does not throw)',
    !quotaThrew);

  uninstallWindow();

  // ── STATIC: the new module exports both functions + the const and is type-checked ──
  const moduleSrc = readFileSync(MODULE_PATH, 'utf8');
  for (const fn of ['readLocalColumnPrefs', 'writeLocalColumnPrefs']) {
    check(`module exports ${fn}`, new RegExp(`export function ${fn}\\b`).test(moduleSrc));
  }
  check('module exports the COLUMN_PREFS_LOCAL_STORAGE_KEY const',
    /export const COLUMN_PREFS_LOCAL_STORAGE_KEY\b/.test(moduleSrc));
  check('module is NOT @ts-nocheck (genuinely type-checked)',
    !/@ts-nocheck/.test(moduleSrc));
  check('module imports the ColumnPrefs type from ./orders-parity',
    /import type \{ ColumnPrefs \} from '\.\/orders-parity'/.test(moduleSrc));

  // ── STATIC: OrdersView imports both and no longer defines either local ──
  const ordersView = readFileSync(ORDERS_VIEW_PATH, 'utf8');
  check("OrdersView imports readLocalColumnPrefs + writeLocalColumnPrefs from ./orders-column-prefs-local",
    /import \{ readLocalColumnPrefs, writeLocalColumnPrefs \} from '\.\/orders-column-prefs-local'/.test(ordersView));
  check('OrdersView no longer defines function readLocalColumnPrefs',
    !/function readLocalColumnPrefs\b/.test(ordersView));
  check('OrdersView no longer defines function writeLocalColumnPrefs',
    !/function writeLocalColumnPrefs\b/.test(ordersView));
  check('OrdersView no longer declares a local COLUMN_PREFS_LOCAL_STORAGE_KEY',
    !/COLUMN_PREFS_LOCAL_STORAGE_KEY/.test(ordersView));
  check('OrdersView still calls readLocalColumnPrefs( (call site preserved)',
    /readLocalColumnPrefs\(/.test(ordersView));
  check('OrdersView still calls writeLocalColumnPrefs( (call sites preserved)',
    /writeLocalColumnPrefs\(/.test(ordersView));

  // package.json wiring is added by the orchestrator (this slice must not edit
  // package.json), so this is informational only — not a gate on this guard.
  const wired = /test:ps-258-orders-column-prefs-local/.test(readFileSync('package.json', 'utf8'));
  console.log(`info ${wired ? 'ok  ' : 'pend'} package.json wires test:ps-258-orders-column-prefs-local (orchestrator-owned)`);

  if (failures > 0) {
    console.error(`\nFAIL PS-258 orders-column-prefs-local guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-258 orders-column-prefs-local guard');
}

void main();
