/**
 * PS-370 Phase 1 — one canonical selected/label shipping cost parity guard.
 *
 * "What did the label cost" (postage + other) was derived in 3 places that agree
 * only by luck: inline TS in billing.ts, resolveBillingSelectedRateCost, and the
 * HUGRAB floor SQL. Phase 1 adds a persisted shipments.selected_rate_cost that all
 * three PREFER, falling back to their existing derivation for NULL (un-backfilled)
 * rows — byte-identical today. This guard proves:
 *   1. When the column is present, all three resolve to it.
 *   2. When the column is NULL, the three fallbacks agree (the parity that was
 *      previously unenforced).
 *   3. The persisted column reads/writes are wired (schema, migration, ensure,
 *      readers, label + sync writers), and no reader changed its NULL-row number.
 *
 *   npx tsx scripts/ps-370-selected-rate-cost-parity-guard.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolveBillingSelectedRateCost } from '../src/services/billing-selected-rate-cost';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const round2 = (n: number) => Math.round(n * 100) / 100;

// Pure replicas of the two DB-bound derivations (pinned to source below so they
// cannot silently drift from the real readers).
//  - billing.ts invoice line: (toNum(cost) || toNum(labelCost)) + toNum(otherCost)
const toNum = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
function billingGenerateLabelCost(row: {
  selectedRateCost?: unknown; cost?: unknown; labelCost?: unknown; otherCost?: unknown;
}): number {
  const persisted = Number(row.selectedRateCost);
  if (row.selectedRateCost != null && row.selectedRateCost !== '' && Number.isFinite(persisted)) return persisted;
  return round2((toNum(row.cost) || toNum(row.labelCost)) + toNum(row.otherCost));
}
//  - HUGRAB floor SQL: round(coalesce(persisted, postage + other, selected_total), 2)
function hugrabFloorSelectedRateCost(row: {
  selectedRateCost?: unknown; cost?: unknown; labelCost?: unknown; otherCost?: unknown;
}): number {
  const persisted = Number(row.selectedRateCost);
  if (row.selectedRateCost != null && row.selectedRateCost !== '' && Number.isFinite(persisted)) return round2(persisted);
  const postage = row.cost != null ? Number(row.cost) : row.labelCost != null ? Number(row.labelCost) : null;
  const other = row.otherCost != null ? Number(row.otherCost) : 0;
  if (postage != null && Number.isFinite(postage)) return round2(postage + other);
  return 0;
}

// ── 1) column PRESENT: all three resolve to the persisted value ──────────────
for (const persisted of [7.5, 12.0, 0.0, 9.44]) {
  // Deliberately give components that DISAGREE with the column, to prove the
  // column wins (not coincidental component agreement).
  const row = { selectedRateCost: persisted.toFixed(2), cost: '999.99', labelCost: '888.88', otherCost: '5.00', selectedRateJson: null };
  const viaResolver = resolveBillingSelectedRateCost(row);
  const viaGenerate = billingGenerateLabelCost(row);
  const viaFloor = hugrabFloorSelectedRateCost(row);
  check(`column present (${persisted}) — resolver returns the column, not the components`,
    viaResolver === round2(persisted), `got ${viaResolver}`);
  check(`column present (${persisted}) — all three agree on the persisted value`,
    viaResolver === viaGenerate && viaGenerate === viaFloor && viaFloor === round2(persisted),
    `resolver=${viaResolver} generate=${viaGenerate} floor=${viaFloor}`);
}

// ── 2) column NULL: the three fallbacks AGREE (byte-identical to today) ───────
const nullFixtures = [
  { label: 'synced (cost only, other=0)', cost: '8.00', otherCost: '0.00', selectedRateJson: null },
  { label: 'insured label (cost + other)', cost: '8.00', otherCost: '1.75', selectedRateJson: null },
  { label: 'labelCost fallback (no cost)', cost: null, labelCost: '6.20', otherCost: '0.00', selectedRateJson: null },
  { label: 'cost + other with JSON present', cost: '10.50', otherCost: '2.00',
    selectedRateJson: { shipmentCost: 10.5, otherCost: 2, totalCost: 12.5 } },
];
for (const f of nullFixtures) {
  const row = { selectedRateCost: null, ...f };
  const viaResolver = resolveBillingSelectedRateCost(row);
  const viaGenerate = billingGenerateLabelCost(row);
  const viaFloor = hugrabFloorSelectedRateCost(row);
  check(`NULL column — ${f.label}: resolver === generate === floor`,
    viaResolver === viaGenerate && viaGenerate === viaFloor,
    `resolver=${viaResolver} generate=${viaGenerate} floor=${viaFloor}`);
}

// ── 3) resolver preference + byte-identical fallback (direct behavioral) ──────
check('resolver: persisted column wins over divergent components',
  resolveBillingSelectedRateCost({ selectedRateCost: '7.50', cost: '999', otherCost: '5', selectedRateJson: null }) === 7.5);
check('resolver: NULL column falls back to cost + otherCost (unchanged)',
  resolveBillingSelectedRateCost({ selectedRateCost: null, cost: '8.00', otherCost: '1.75', selectedRateJson: null }) === 9.75);
check('resolver: a genuinely $0 persisted total is honored (not treated as absent)',
  resolveBillingSelectedRateCost({ selectedRateCost: '0.00', cost: '8', otherCost: '1', selectedRateJson: null }) === 0);

// ── 4) source pins: the column is wired end to end ───────────────────────────
const schema = read('src/db/schema/shipments.ts');
check('schema: shipments.selectedRateCost additive numeric column exists',
  /selectedRateCost:\s*numeric\(\{ precision: 10, scale: 2 \}\)/.test(schema) &&
  !/selectedRateCost:[^\n]*\.notNull\(\)/.test(schema));
check('migration 0054 adds the column additively (IF NOT EXISTS)',
  /ADD COLUMN IF NOT EXISTS "selected_rate_cost" numeric\(10, 2\)/.test(read('drizzle/0054_shipments_selected_rate_cost.sql')));
check('runtime helper delegates to migration readiness without shipment DDL',
  /assertRuntimeSchemaReady/.test(read('src/db/ensure-shipments-selected-rate-cost.ts')) &&
  !/ALTER TABLE shipments ADD COLUMN/i.test(read('src/db/ensure-shipments-selected-rate-cost.ts')));

const billing = read('src/services/billing.ts');
check('reader (billing generate) prefers the persisted column, falls back to cost/labelCost + otherCost',
  /const labelCost = resolveBillingSelectedRateCost\(\{/.test(billing) &&
  /selectedRateCost: s\.selectedRateCost/.test(billing) &&
  /selectedRateJson: s\.selectedRateJson/.test(billing));
check('reader (billing generate) SELECTs the new column',
  /selectedRateCost: shipments\.selectedRateCost/.test(billing) &&
  /selectedRateJson: shipments\.selectedRateJson/.test(billing));
check('reader (billingDetails) threads the column into resolveBillingSelectedRateCost',
  /selectedRateCost: row\.selectedRateCost \?\? fallbackShipment\?\.selectedRateCost/.test(billing));

const resolver = read('src/services/billing-selected-rate-cost.ts');
// Repointed 2026-08-04. This pinned `roundCents(persisted)`. PS-457 consolidated
// cent rounding into one named owner and roundCents no longer exists anywhere in
// src -- every call site is roundMoney now, which is the whole point of that
// ticket. The preference order this check exists to protect (persisted column
// first, component derivation second) never changed.
//
// Third guard today rotted by the same consolidation, after
// ps-217-billing-export-box-fields and the PS-434 pair. Renaming a shared money
// helper is exactly the kind of change that breaks source-pinned guards in bulk,
// and none of them ran, so the breakage was invisible.
check('resolver prefers the persisted column before the component derivation',
  /const persisted = toFiniteNumber\(input\.selectedRateCost\)[\s\S]{0,80}if \(persisted != null\) return roundMoney\(persisted\)/.test(resolver));

const floor = read('src/services/hugrab-billing-shipping-floor.ts');
check('HUGRAB floor SQL coalesces the persisted column FIRST',
  /coalesce\(s\.selected_rate_cost, fs\.selected_rate_cost\) as persisted_selected_rate_cost/.test(floor) &&
  /coalesce\(\s*src\.persisted_selected_rate_cost,\s*money\.postage_cost \+ money\.other_cost,\s*money\.selected_total\s*\)/.test(floor));

// PS-370 (review fix): the READ paths must also ensure the column exists (pre-
// migration belt-and-suspenders) — else a billing read on a fresh deploy before
// any label/sync throws "column does not exist".
check('read path: billing.ts imports + ensures the column on BOTH read paths (generate + details)',
  /import \{ ensureShipmentsSelectedRateCostColumn \}/.test(billing) &&
  (billing.match(/await ensureShipmentsSelectedRateCostColumn\(\)/g) ?? []).length >= 2);
check('read path (generateLineItems) ensures the column near the top of the function',
  /export async function generateLineItems[\s\S]{0,1200}await ensureShipmentsSelectedRateCostColumn\(\)/.test(billing));
check('read path (billingDetails) ensures the column before its SELECT',
  /export async function billingDetails[\s\S]{0,400}await ensureShipmentsSelectedRateCostColumn\(\)/.test(billing));
check('read path (HUGRAB floor) ensures the column before its db.execute',
  /await ensureShipmentsSelectedRateCostColumn\(\);[\s\S]{0,160}const rows = await db\.execute/.test(floor));

const labels = read('src/services/labels.ts');
check('label writer populates the column = postage + other (byte-consistent with the readers)',
  /selectedRateCost: Number\(\(created\.cost \+ insuranceCost\)\.toFixed\(2\)\)\.toFixed\(2\)/.test(labels) &&
  /await ensureShipmentsSelectedRateCostColumn\(\);/.test(labels));
const sync = read('src/services/shipment-sync.ts');
check('sync writer populates the column on NEW inserts only (never on update — preserves otherCost)',
  /values\.otherCost = toNumeric\(s\.insuranceCost\) \?\? '0\.00'/.test(sync) &&
  /values\.selectedRateCost = resolveBillingSelectedRateCost\(\{/.test(sync) &&
  /if \(toInsert\.length\) await ensureShipmentsSelectedRateCostColumn\(\)/.test(sync));

// ── 5) safety: no shipped-row MUTATION in Phase 1 (additive column only) ─────
check('ensure file does an ADD COLUMN only — no UPDATE/DELETE/DROP against shipments',
  !/\b(update|delete|drop)\b/i.test(read('src/db/ensure-shipments-selected-rate-cost.ts').replace(/\/\/[^\n]*/g, '')));

if (failures > 0) {
  console.error(`\nPS-370 selected-rate-cost parity guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-370 selected-rate-cost parity guard passed.');
