/**
 * PS-153 — dead schema/interface symbol hygiene guard.
 *
 * Two distinct outcomes from the PS-153 audit (2026-06-09):
 *   1. `cancelOrder?` on the StoreConnector interface was genuinely dead (0 impls, 0 callers) and is
 *      REMOVED. This guard asserts it stays gone.
 *   2. `skuQtyDims` (sku_qty_dims) and `syncMeta` (sync_meta) are CODE-DEAD (no Drizzle ref, no raw-SQL
 *      access in src/) BUT their pgTable definitions are RETAINED ON PURPOSE: drizzle-kit generate diffs
 *      schema-vs-DB, so deleting a definition would arm the next migration to DROP the live table (data
 *      loss). This guard PINS the definitions in place + asserts they remain code-dead, so neither a
 *      naive "delete dead code" pass nor a silent new consumer slips through unnoticed.
 *
 * Offline / pure: readFileSync + readdir only. No DB, no network.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const types = readFileSync('src/connectors/types.ts', 'utf8');
const products = readFileSync('src/db/schema/products.ts', 'utf8');
const syncMeta = readFileSync('src/db/schema/sync-meta.ts', 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

function countRefs(symbol: string, ignoreFileSuffix: string): number {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) { if (e !== 'node_modules') walk(p); }
      else if (p.endsWith('.ts')) files.push(p);
    }
  })('src');
  const re = new RegExp(`\\b${symbol}\\b`);
  return files.filter((f) => !f.replace(/\\/g, '/').endsWith(ignoreFileSuffix) && re.test(readFileSync(f, 'utf8'))).length;
}

// ── (1) cancelOrder? stays removed from the connector interface ──
check('cancelOrder? removed from StoreConnector (dead optional method)',
  !/cancelOrder\??\s*\(/.test(types));

// ── (2) skuQtyDims: definition RETAINED + code-dead + anti-drop rationale documented ──
check('skuQtyDims pgTable definition retained in products.ts (do not arm a DROP)',
  /export const skuQtyDims = pgTable\(/.test(products));
check('skuQtyDims retention rationale documented', /RETAINED ON PURPOSE[\s\S]*DROP/.test(products));
check('skuQtyDims has 0 live consumers in src/ (still dead-but-retained)',
  countRefs('skuQtyDims', 'src/db/schema/products.ts') === 0);

// ── (3) syncMeta: definition RETAINED + code-dead + anti-drop rationale documented ──
check('syncMeta pgTable definition retained in sync-meta.ts (do not arm a DROP)',
  /export const syncMeta = pgTable\('sync_meta'/.test(syncMeta));
check('syncMeta retention rationale documented', /RETAINED ON PURPOSE[\s\S]*DROP/.test(syncMeta));
check('syncMeta has 0 live consumers in src/ (still dead-but-retained)',
  // its own file defines syncMeta + SyncMeta + NewSyncMeta; index.ts re-exports it (a barrel passthrough,
  // not a consumer). Allow the schema file + the barrel; assert no OTHER file references it.
  countRefs('syncMeta', 'src/db/schema/sync-meta.ts') <= 1);

if (failures > 0) {
  console.error(`\nFAIL PS-153 dead-symbols guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-153 dead-symbols guard');
