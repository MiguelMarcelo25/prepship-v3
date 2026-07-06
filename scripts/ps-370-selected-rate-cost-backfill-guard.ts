/**
 * PS-370 Phase 2 — backfill planner guard (offline, no db).
 *
 * Proves the HISTORY backfill writes only durable selected-cost proof:
 *   - affected rows write resolver-proven JSON total or postage + other;
 *   - no-cost/no-JSON-proof rows are SKIPPED (left NULL);
 *   - already-set rows are idempotently skipped (never overwritten);
 *   - the script is dry-run-first + double-gated and writes ONLY the column.
 *
 *   npx tsx scripts/ps-370-selected-rate-cost-backfill-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  planSelectedRateCostBackfillRow,
  summarizeSelectedRateCostBackfill,
} from '../src/services/shipping-workflow/selected-rate-cost-backfill';
import { resolveBillingSelectedRateCost } from '../src/services/billing-selected-rate-cost';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}
const read = (p: string) => readFileSync(p, 'utf8');
const round2 = (n: number) => Math.round(n * 100) / 100;

// The billing-generate component fallback for rows with postage proof.
const toNum = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const generateReader = (r: { cost?: unknown; labelCost?: unknown; otherCost?: unknown }) =>
  round2((toNum(r.cost) || toNum(r.labelCost)) + toNum(r.otherCost));

const row = (over: Record<string, unknown>) => ({
  shipmentId: 1, orderNumber: 'B-1', cost: null, labelCost: null, otherCost: '0',
  selectedRateJson: null, selectedRateCost: null, ...over,
}) as Parameters<typeof planSelectedRateCostBackfillRow>[0];

// ── affected rows: value === BOTH readers (byte-identical) ───────────────────
for (const f of [
  { cost: '8.00', otherCost: '0.00' },
  { cost: '8.00', otherCost: '1.75' },
  { cost: null, labelCost: '6.20', otherCost: '0.00' },
  { cost: '10.50', otherCost: '2.00', selectedRateJson: { shipmentCost: 10.5, otherCost: 2, totalCost: 12.5 } },
]) {
  const r = row(f);
  const plan = planSelectedRateCostBackfillRow(r);
  const gen = generateReader(r);
  const res = resolveBillingSelectedRateCost({ cost: r.cost, labelCost: r.labelCost, otherCost: r.otherCost, selectedRateJson: r.selectedRateJson });
  check(`affected + value === both readers (cost=${f.cost}, other=${f.otherCost ?? '0'})`,
    plan.affected && plan.value === gen && plan.value === round2(res!),
    `plan=${plan.value} gen=${gen} res=${res}`);
}

// ── JSON-total proof is durable; no-proof rows are SKIPPED, left NULL ─────────
{
  // PS-381: cost+labelCost both null, but selected-rate JSON has a total.
  const r = row({ cost: null, labelCost: null, otherCost: '2.00', selectedRateJson: { shipmentCost: 5, totalCost: 7 } });
  const plan = planSelectedRateCostBackfillRow(r);
  check('JSON-total proof is backfilled from the resolver',
    plan.affected && plan.value === 7 && plan.skipReason === null);
}
{
  // No cost data at all.
  const plan = planSelectedRateCostBackfillRow(row({ cost: null, labelCost: null, otherCost: '0' }));
  check('no recorded cost is SKIPPED', !plan.affected && plan.skipReason === 'no_recorded_cost');
}

// ── idempotent: already-set column is never rewritten ────────────────────────
{
  const plan = planSelectedRateCostBackfillRow(row({ cost: '8.00', otherCost: '1.00', selectedRateCost: '9.00' }));
  check('already-set column is SKIPPED (idempotent, never overwritten)',
    !plan.affected && plan.skipReason === 'already_set');
}
{
  // A genuinely $0 persisted column still counts as set (not re-backfilled).
  const plan = planSelectedRateCostBackfillRow(row({ cost: '8.00', otherCost: '1.00', selectedRateCost: '0.00' }));
  check('persisted $0 column is treated as SET (not divergent, not re-written)',
    !plan.affected && plan.skipReason === 'already_set');
}

// ── summary tallies every disposition ────────────────────────────────────────
{
  const plans = [
    planSelectedRateCostBackfillRow(row({ cost: '8.00', otherCost: '1.00' })),          // affected
    planSelectedRateCostBackfillRow(row({ cost: '5.00', otherCost: '0.00' })),          // affected
    planSelectedRateCostBackfillRow(row({ selectedRateCost: '3.00' })),                 // already_set
    planSelectedRateCostBackfillRow(row({ cost: null, labelCost: null, otherCost: '1' })), // no_recorded_cost
  ];
  const s = summarizeSelectedRateCostBackfill(plans);
  check('summary: 2 affected, 1 already_set, 1 no_recorded_cost',
    s.total === 4 && s.affected === 2 && s.alreadySet === 1 && s.noRecordedCost === 1,
    JSON.stringify(s));
}

// ── source pins: the script is dry-run-first, double-gated, column-only ───────
const script = read('scripts/ps-370-selected-rate-cost-backfill.ts');
check('script is DRY-RUN by default (apply requires --apply)',
  /const apply = hasFlag\('apply'\)/.test(script) && /if \(!apply\) \{\s*process\.exit\(0\)/.test(script));
check('apply is DOUBLE-GATED (--apply AND --confirm-production)',
  /const willApply = apply && confirmProduction/.test(script) &&
  /if \(!confirmProduction\)/.test(script));
check('write path sets ONLY selected_rate_cost, ONLY where currently NULL',
  /\.set\(\{ selectedRateCost: plan\.value\.toFixed\(2\) \}\)/.test(script) &&
  /and\(eq\(shipments\.id, plan\.shipmentId\), isNull\(shipments\.selectedRateCost\)\)/.test(script));
check('write path touches no other shipment field (no cost/labelCost/otherCost/selectedRateJson in .set)',
  !/\.set\(\{[^}]*\b(cost|labelCost|otherCost|selectedRateJson|orderStatus|trackingNumber|carrierCode)\b/.test(script));
check('script ensures the column before reading (post-deploy safety)',
  /await ensureShipmentsSelectedRateCostColumn\(\)/.test(script));
check('script does not connect on import (invoked-directly guard)',
  /const invokedDirectly =[\s\S]*process\.argv\[1\]/.test(script) && /if \(invokedDirectly\)/.test(script));
check('script documents the DJ gate (AGENTS DO NOT RUN --apply)',
  /AGENTS DO NOT RUN --apply/.test(script) && /unlock shipped data/.test(script));

// ── planner purity: no db/io import (guard-importable offline) ───────────────
const planner = read('src/services/shipping-workflow/selected-rate-cost-backfill.ts');
check('planner imports only the pure resolver (no db/client/schema)',
  /import \{ resolveBillingSelectedRateCost \}/.test(planner) &&
  !/db\/client|db\/schema|drizzle-orm/.test(planner));

if (failures > 0) {
  console.error(`\nPS-370 Phase 2 backfill guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-370 Phase 2 backfill guard passed.');
