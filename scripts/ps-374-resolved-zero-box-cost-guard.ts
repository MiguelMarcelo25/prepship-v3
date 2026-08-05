/**
 * PS-374 — a CONFIRMED $0.00 box cost is a resolved/final decision, not "missing".
 *
 * Bug: after "Bulk set N same box → 0.00 → confirm → apply", the affected rows
 * still showed "No box cost / Needs Review" + the bulk-set prompt. Root cause:
 * decidePackageCostLine collapsed a resolved operator override of 0 to kind
 * 'none' (no package_cost line), so the grouped-DTO alert (which the FE + Invoice
 * both read) saw hasPackageCostLine=false and re-flagged the order as missing.
 *
 * This guard proves, offline (no db):
 *   Layer 1 — the policy owner emits an explicit $0 line for a resolved override.
 *   Layer 2 — the grouped billing-detail DTO (the /billing/details read model the
 *             FE + Invoice consume) marks such an order resolved: no boxCostAlert,
 *             no NO_BOX_COST badge — while a genuinely missing box still alerts.
 *   Layer 3 — source pins so the fix + its consumers can't silently regress.
 *
 *   npx tsx scripts/ps-374-resolved-zero-box-cost-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decidePackageCostLine,
  resolveShippedPackageId,
  type ShippedBoxResolution,
} from '../src/services/billing-box-policy';
import { resolveBillingBoxCostAlert, NO_BOX_COST_BILLING_BADGE } from '../src/services/billing-box-cost-alert';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';

let failures = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`ok   ${name}`); }
  catch (err) { failures += 1; console.error(`FAIL ${name} — ${err instanceof Error ? err.message : err}`); }
}

const emptyLookups = { byId: new Map(), byCode: new Map(), byDims: new Map() };
const resolvedOverride = (overridePrice: number | null, packageId: number | null = 7): ShippedBoxResolution => ({
  status: 'resolved', source: 'operator', packageId, pkg: null, overridePrice, note: null,
});

// ── Layer 1: the policy owner ────────────────────────────────────────────────
check('resolved operator override of $0.00 → explicit $0 line (NOT none)', () => {
  const d = decidePackageCostLine({ resolution: resolvedOverride(0), clientHasBoxPricing: true, configuredPrice: null, markupPct: 0 });
  assert.equal(d.kind, 'line');
  assert.equal((d as { amount: number }).amount, 0);
  assert.equal((d as { packageId: number | null }).packageId, 7);
});

check('the $0 override survives the DB read shape (0.00, not coerced to null)', () => {
  // resolveShippedPackageId is fed operator.overridePrice = 0 (Number("0.00")).
  const res = resolveShippedPackageId({
    operator: { packageId: 7, overridePrice: 0, note: null },
    selectedPid: null, selectedPackageId: null, dimsL: null, dimsW: null, dimsH: null, lookups: emptyLookups,
  });
  assert.equal(res.status, 'resolved');
  assert.equal((res as { overridePrice: number | null }).overridePrice, 0);
  const d = decidePackageCostLine({ resolution: res, clientHasBoxPricing: true, configuredPrice: null, markupPct: 0 });
  assert.equal(d.kind, 'line');
  assert.equal((d as { amount: number }).amount, 0);
});

check('a POSITIVE override is unchanged (line at the override, no markup)', () => {
  const d = decidePackageCostLine({ resolution: resolvedOverride(1.5), clientHasBoxPricing: true, configuredPrice: 0.5, markupPct: 25 });
  assert.deepEqual(d, { kind: 'line', amount: 1.5, packageId: 7, pkgName: 'Box #7' });
});

check('resolved via SELECTION with no override + $0 configured price → still none (free config, unchanged)', () => {
  const selection: ShippedBoxResolution = { status: 'resolved', source: 'dims', packageId: 31, pkg: null, overridePrice: null, note: null };
  assert.equal(decidePackageCostLine({ resolution: selection, clientHasBoxPricing: true, configuredPrice: 0, markupPct: 0 }).kind, 'none');
  assert.equal(decidePackageCostLine({ resolution: selection, clientHasBoxPricing: true, configuredPrice: undefined, markupPct: 0 }).kind, 'none');
});

// ── Layer 2: the alert primitive + the grouped DTO the FE/Invoice consume ─────
check('alert: an explicit $0 package_cost line is resolved (no alert); a MISSING line still alerts', () => {
  const resolvedZero = resolveBillingBoxCostAlert({ packageCost: 0, hasPackageCostLine: true, canAlertMissing: true, clientHasBoxPricing: true });
  assert.equal(resolvedZero.boxCostAlert, false);
  assert.ok(!resolvedZero.billingBadges.includes(NO_BOX_COST_BILLING_BADGE));
  const missing = resolveBillingBoxCostAlert({ packageCost: null, hasPackageCostLine: false, canAlertMissing: true, clientHasBoxPricing: true });
  assert.equal(missing.boxCostAlert, true);
  assert.ok(missing.billingBadges.includes(NO_BOX_COST_BILLING_BADGE));
});

check('grouped DTO: a $0 package_cost order is resolved (no boxCostAlert / NO_BOX_COST)', () => {
  const [dto] = toBillingDetailOrderRows([
    { orderId: 100, lineType: 'pick_pack', totalCost: '2.00', clientHasBoxPricing: true },
    { orderId: 100, lineType: 'package_cost', totalCost: '0.00', packageId: 7, clientHasBoxPricing: true },
  ]);
  assert.equal(dto.hasPackageCostLine, true);
  assert.equal(dto.packageTotal, 0);
  assert.equal(dto.boxCostAlert, false, 'resolved $0 box must NOT alert');
  assert.ok(!dto.billingBadges.includes(NO_BOX_COST_BILLING_BADGE));
  assert.equal(dto.packageCostNeedsReview === true, false);
});

check('grouped DTO: an order with NO box line at all still alerts (the pre-fix state)', () => {
  const [dto] = toBillingDetailOrderRows([
    { orderId: 101, lineType: 'shipping', totalCost: '5.00', clientHasBoxPricing: true },
  ]);
  assert.equal(dto.hasPackageCostLine, false);
  assert.equal(dto.boxCostAlert, true, 'a genuinely missing box cost must still alert');
  assert.ok(dto.billingBadges.includes(NO_BOX_COST_BILLING_BADGE));
});

check('grouped DTO: an unresolved package_cost_missing review line shows review, not NO_BOX_COST', () => {
  const [dto] = toBillingDetailOrderRows([
    { orderId: 102, lineType: 'package_cost_missing', totalCost: '0.00', packageCostNeedsReview: true, clientHasBoxPricing: true },
  ]);
  assert.equal(dto.packageCostNeedsReview, true);
  assert.equal(dto.boxCostAlert, false, 'a review line is NEEDS REVIEW, not the No box cost alert');
  assert.ok(!dto.billingBadges.includes(NO_BOX_COST_BILLING_BADGE));
});

// ── Layer 3: source pins ─────────────────────────────────────────────────────
check('policy: the override branch returns a line (never none) for an explicit override', () => {
  const policy = readFileSync('src/services/billing-box-policy.ts', 'utf8');
  assert.ok(/PS-374[\s\S]*if \(r\.overridePrice != null\) \{[\s\S]*kind: 'line'/.test(policy),
    'decidePackageCostLine must emit a line for any explicit operator override');
});

check('generator still emits kind:line as a package_cost line + kind:review as $0 package_cost_missing', () => {
  const service = readFileSync('src/services/billing.ts', 'utf8');
  assert.ok(/packageCostDecision\.kind === 'line'/.test(service) && /lineType: 'package_cost'/.test(service));
  assert.ok(/lineType: 'package_cost_missing'/.test(service) && /unitCost: '0\.00'/.test(service));
});

check('bulk apply persists the reviewed override (incl. 0.00) as billing_box_resolutions.overridePrice', () => {
  const bulk = readFileSync('src/services/billing-box-cost-bulk.ts', 'utf8');
  // Repointed 2026-08-05: round2 -> roundMoney. PS-457 consolidated every ad-hoc money
  // rounding onto one owner, which is precisely what a $0-vs-null box cost guard wants:
  // the reviewed override and the billed amount round identically. Pin the canonical
  // rounder rather than the old local name.
  assert.ok(/const overridePrice = roundMoney\(scope\.newCost\)\.toFixed\(2\)/.test(bulk));
  assert.ok(/\.insert\(billingBoxResolutions\)[\s\S]*overridePrice/.test(bulk));
});

check('FE No box cost affordance keys on the backend boxCostAlert / NO_BOX_COST badge (no FE math)', () => {
  const fe = readFileSync('web/src/components/Views/BillingNoBoxCostAction.tsx', 'utf8');
  assert.ok(/row\.boxCostAlert === true/.test(fe) && /includes\('NO_BOX_COST'\)/.test(fe));
});

if (failures > 0) {
  console.error(`\nPS-374 resolved-zero box-cost guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-374 resolved-zero box-cost guard passed.');
