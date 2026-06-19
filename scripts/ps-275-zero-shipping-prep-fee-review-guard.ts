/**
 * PS-275 — $0-shipping review + prep-fee waiver guard.
 *
 * Pins the pure policy that the billing generator / route / FE all delegate to.
 * No DB, no network, no postage — imports the REAL pure owner.
 *
 *   1. decideZeroShippingReview: TRUE only for EXACTLY $0; missing/unknown
 *      (null/undefined/NaN) is NOT $0 (it stays the separate missing-cost
 *      review); negatives are not $0 either.
 *   2. applyPrepFeeWaiver(waived=false): a TRUE no-op — same array reference,
 *      byte-identical (no waiver => byte-identical billing).
 *   3. applyPrepFeeWaiver(waived=true): zeroes ONLY prep/fulfillment/pick-pack
 *      fee lines (unitCost+totalCost -> '0.00'); product revenue, marketplace
 *      fees, package/box cost, storage, and the shipping label cost are NEVER
 *      zeroed.
 *   4. Idempotent: applying the waiver twice equals applying it once.
 *   5. Reversible: re-running with waived=false restores the ORIGINAL prep
 *      amounts (the waiver never mutates its input).
 *   6. isPrepFeeLine matches both camelCase (lineType) and snake_case
 *      (line_type) keys and the documented prep/fulfillment aliases.
 *
 *   npx tsx scripts/ps-275-zero-shipping-prep-fee-review-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  applyPrepFeeWaiver,
  decideZeroShippingReview,
  isPrepFeeLine,
  PREP_FEE_LINE_TYPES,
  type WaivableLine,
} from '../src/services/billing-shipping-policy';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── 1) decideZeroShippingReview: exact-$0 ONLY; missing != $0 ──────────────
{
  check('EXACT $0 -> needsReview true',
    decideZeroShippingReview({ shippingAmount: 0 }).needsReview === true);
  check('EXACT 0.0 -> needsReview true',
    decideZeroShippingReview({ shippingAmount: 0.0 }).needsReview === true);
  check('positive amount -> false',
    decideZeroShippingReview({ shippingAmount: 7.42 }).needsReview === false);
  check('null (UNKNOWN/missing) -> false (NOT $0; stays missing-cost review)',
    decideZeroShippingReview({ shippingAmount: null }).needsReview === false);
  check('undefined (UNKNOWN) -> false',
    decideZeroShippingReview({ shippingAmount: undefined }).needsReview === false);
  check('NaN (UNKNOWN) -> false',
    decideZeroShippingReview({ shippingAmount: Number.NaN }).needsReview === false);
  check('negative -> false (not $0)',
    decideZeroShippingReview({ shippingAmount: -0.01 }).needsReview === false);
  check('context flags do not relax the exact-$0 rule (missing + externallyShipped still false)',
    decideZeroShippingReview({ shippingAmount: null, externallyShipped: true, hasShipmentRow: true }).needsReview === false);
}

// A representative order's billing lines: prep + shipping + product/mp/box/storage/label.
function sampleOrderLines(): WaivableLine[] {
  return [
    { lineType: 'pick_pack', unitCost: '2.50', totalCost: '2.50' },
    { lineType: 'additional_unit', unitCost: '0.50', totalCost: '1.50' },
    { lineType: 'shipping', unitCost: '0.00', totalCost: '0.00' }, // the $0 label
    { lineType: 'package_cost', unitCost: '0.85', totalCost: '0.85' }, // box — NEVER waived
    { lineType: 'storage', unitCost: '0.10', totalCost: '4.20' }, // storage — NEVER waived
    { lineType: 'product', unitCost: '19.99', totalCost: '19.99' }, // revenue — NEVER waived
    { lineType: 'marketplace_fee', unitCost: '3.00', totalCost: '3.00' }, // mp fee — NEVER waived
    { lineType: 'shipping_label', unitCost: '5.55', totalCost: '5.55' }, // label cost — NEVER waived
  ];
}

// ── 2) waived=false is a TRUE no-op (no waiver => byte-identical) ───────────
{
  const lines = sampleOrderLines();
  const out = applyPrepFeeWaiver(lines, false);
  check('OFF path: returns the SAME array reference (no-op)', out === lines);
  check('OFF path: byte-identical JSON', JSON.stringify(out) === JSON.stringify(lines));
}

// ── 3) waived=true zeroes ONLY prep/fulfillment/pick-pack lines ────────────
{
  const lines = sampleOrderLines();
  const before = JSON.stringify(lines);
  const out = applyPrepFeeWaiver(lines, true);

  const byType = (t: string) => out.find((l) => l.lineType === t)!;
  check('pick_pack zeroed', byType('pick_pack').totalCost === '0.00' && byType('pick_pack').unitCost === '0.00');
  check('additional_unit zeroed', byType('additional_unit').totalCost === '0.00');
  // The protected categories are untouched.
  check('package/box cost NOT zeroed', byType('package_cost').totalCost === '0.85');
  check('storage NOT zeroed', byType('storage').totalCost === '4.20');
  check('product revenue NOT zeroed', byType('product').totalCost === '19.99');
  check('marketplace fee NOT zeroed', byType('marketplace_fee').totalCost === '3.00');
  check('shipping label cost NOT zeroed', byType('shipping_label').totalCost === '5.55');
  // The $0 shipping line stays $0 (it already was) and is not a prep line.
  check('shipping line not treated as prep', isPrepFeeLine({ lineType: 'shipping' }) === false);
  // Input was not mutated (waiver builds a new array).
  check('input list NOT mutated', JSON.stringify(lines) === before);
}

// ── 4) idempotent: applying twice == applying once ─────────────────────────
{
  const lines = sampleOrderLines();
  const once = applyPrepFeeWaiver(lines, true);
  const twice = applyPrepFeeWaiver(once, true);
  check('idempotent: waive twice == waive once', JSON.stringify(twice) === JSON.stringify(once));
}

// ── 5) reversible: re-run with waived=false restores ORIGINAL prep amounts ──
{
  const original = sampleOrderLines();
  const originalJson = JSON.stringify(original);
  // Apply then "clear" the waiver. Clearing = regenerate from the same source
  // with waived=false; the policy never mutated the source, so it is identical.
  applyPrepFeeWaiver(original, true);
  const restored = applyPrepFeeWaiver(sampleOrderLines(), false);
  check('reversible: clearing the waiver restores original prep amounts',
    JSON.stringify(restored) === originalJson);
}

// ── 6) isPrepFeeLine handles both casings + the documented aliases ─────────
{
  check('snake_case line_type recognized', isPrepFeeLine({ line_type: 'pick_pack' }) === true);
  check('fulfillment alias recognized', isPrepFeeLine({ lineType: 'fulfillment' }) === true);
  check('prep alias recognized', isPrepFeeLine({ lineType: 'prep_fee' }) === true);
  check('non-prep type rejected', isPrepFeeLine({ lineType: 'package_cost' }) === false);
  check('the canonical prep set contains pick_pack + additional_unit',
    PREP_FEE_LINE_TYPES.has('pick_pack') && PREP_FEE_LINE_TYPES.has('additional_unit'));
  check('the canonical prep set EXCLUDES shipping/box/storage/product/marketplace',
    !PREP_FEE_LINE_TYPES.has('shipping') &&
    !PREP_FEE_LINE_TYPES.has('package_cost') &&
    !PREP_FEE_LINE_TYPES.has('storage') &&
    !PREP_FEE_LINE_TYPES.has('product') &&
    !PREP_FEE_LINE_TYPES.has('marketplace_fee'));
}

// ── 7) FE discoverability: operators must be able to SEE which rows need the ──
//      $0-shipping review without opening every Edit modal. Pure static reads
//      (no DB, no render) over the billing FE source. These pin that:
//        (a) the per-row Review control is gated on shippingZeroNeedsReview and
//            opens the SAME edit modal (onOpenBillingEdit), and
//        (b) a needs-review count/badge derives from shippingZeroNeedsReview
//            using the same rows the table renders.
{
  // Repo convention (see ps-258/ps-177 FE guards): cwd-relative paths, run from
  // the repo root via `npx tsx`. Avoids ESM `__dirname is not defined`.
  const detailTableSrc = readFileSync('web/src/components/Views/BillingDetailTable.tsx', 'utf8');
  const billingViewSrc = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');

  // (a) Row-level Review control: a >Review< button rendered only when the row
  //     flag is set, wired to the existing modal-open handler (no new handler).
  const hasReviewLabel = /['"`>\s]Review['"`<\s]/.test(detailTableSrc);
  const rowGatedOnFlag = /row\.shippingZeroNeedsReview\s*\?/.test(detailTableSrc);
  const reusesModalOpen = /onOpenBillingEdit\(row\)/.test(detailTableSrc);
  check('FE(a): per-row Review control is gated on row.shippingZeroNeedsReview',
    rowGatedOnFlag);
  check('FE(a): the Review control reuses the existing edit-modal open handler (onOpenBillingEdit(row))',
    hasReviewLabel && reusesModalOpen);

  // (b) Header count/badge: a needs-review tally derived from
  //     shippingZeroNeedsReview over the rendered rows array, with the badge copy.
  const badgeDerivesFromFlag =
    /sortedDetailRows[\s\S]{0,80}shippingZeroNeedsReview\s*===\s*true/.test(billingViewSrc) ||
    /shippingZeroNeedsReview\s*===\s*true[\s\S]{0,80}\.length/.test(billingViewSrc);
  const hasBadgeCopy = /\$0-shipping need review/.test(billingViewSrc);
  check('FE(b): a needs-review count derives from shippingZeroNeedsReview over sortedDetailRows',
    badgeDerivesFromFlag);
  check('FE(b): the header renders the $0-shipping needs-review badge copy',
    hasBadgeCopy);
}

// ── 8) ROOT CAUSE: the generator must EMIT a $0.00 shipping review line for ──
//      internal $0-cost shipments, or the review is unreachable. billing.ts
//      only emits a normal shipping line when labelCost>0 (so its amount is
//      always >0), and externally-shipped orders go to 'shipping_missing'. An
//      order WE fulfilled (a real shipment) with $0/blank recorded cost used to
//      fall through every branch and produce NO shipping line — dropping the
//      order out of billing entirely, so decideZeroShippingReview never saw a
//      $0 shipping line. This pins the dedicated fall-through branch that fixes
//      it. Pure static read (the generator needs a DB; this asserts the source).
{
  const billingSrc = readFileSync('src/services/billing.ts', 'utf8');
  const hasInternalZeroBranch = /else if \(s\.id != null\)/.test(billingSrc);
  const emitsZeroShippingReviewLine = /no recorded cost/.test(billingSrc);
  const citesOverride =
    /Per user override unlock shipped data on 2026-06-17[\s\S]{0,1200}no recorded cost/.test(billingSrc);
  check('GEN: internal $0-cost shipments hit a dedicated fall-through branch (else if s.id != null)',
    hasInternalZeroBranch);
  check('GEN: that branch emits an explicit $0.00 shipping review line so detection can fire',
    emitsZeroShippingReviewLine);
  check('GEN: the locked-surface billing edit cites the unlock override',
    citesOverride);
}

// ── 9. The GENERATOR consumes the persisted waiver (the pure policy is wired, not just defined) ────
//      Static pins so a refactor cannot silently stop applying a saved waiver. The amounts that flow to
//      details/summary/exports are the WAIVED rows (effectiveRows), persisted under the idempotent
//      DELETE-then-rebuild + ON CONFLICT contract.
{
  const gen = readFileSync('src/services/billing.ts', 'utf8');
  check('gen: the generate path LOADS the persisted waivers (readBillingFeeWaivers)',
    /await readBillingFeeWaivers\(/.test(gen));
  check('gen: each order resolves its decision (waived = waiver?.decision === \'waived\')',
    /const waived = waiver\?\.decision === 'waived'/.test(gen));
  check('gen: the PERSISTED rows are the WAIVED rows (effectiveRows = applyPrepFeeWaiver(rows, waived) is what is collected)',
    /const effectiveRows = applyPrepFeeWaiver\(rows, waived\)/.test(gen) &&
    /for \(const row of effectiveRows\)/.test(gen));
  check('gen: regenerate DELETEs the period then rebuilds with ON CONFLICT DO NOTHING (idempotent)',
    /\.delete\(billingLineItems\)/.test(gen) && /onConflictDoNothing\(/.test(gen));
}

// ── 10. The review ROUTE is auth + client-scope gated, reversible-capture, and read-gated ──────────
{
  const route = readFileSync('src/routes/billing.ts', 'utf8');
  check('route: POST /zero-shipping-review requires financials:write',
    /zero-shipping-review/.test(route) && /requirePermission\('financials:write'\)/.test(route));
  check('route: enforces client scope + 404s when the order is out of scope',
    /billingClientScopePredicate\(scope\)/.test(route) && /'Billing line item not found' \}, 404/.test(route));
  check('route: captures the REVERSIBLE original prep total from the canonical PREP_FEE_LINE_TYPE_LIST',
    /PREP_FEE_LINE_TYPE_LIST/.test(route) && /original_prep_amount/.test(route));
  check('route: persists the decision via upsertBillingFeeWaiver', /upsertBillingFeeWaiver\(\{/.test(route));
}

if (failures > 0) {
  console.error(`\nFAIL PS-275 zero-shipping prep-fee review guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-275 zero-shipping prep-fee review guard');
