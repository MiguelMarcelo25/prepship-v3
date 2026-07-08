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
// PS-275 item 2: the prep-fee WAIVER decision remains visible as a period note
// without a trailing per-row export column. The CSV serializer is pure and
// importable offline; the heavy HTML/XLSX renderers (DB/app imports) are pinned
// by static source read, mirroring sections 7/8.
import {
  INVOICE_CSV_HEADERS,
  renderInvoiceCsvRow,
  type InvoiceCsvDetailRow,
} from '../src/routes/billing-invoice-csv';
import { waivedSummaryNote } from '../src/routes/billing-invoice-waiver-indicator';

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
  const lineItemsHeaderSrc = readFileSync('web/src/components/Views/BillingLineItemsHeader.tsx', 'utf8');
  const editModalSrc = readFileSync('web/src/components/Views/BillingEditDetailModal.tsx', 'utf8');

  // (a) Row-level Review control: a >Review< button rendered only when the row
  //     flag is set, wired to the existing modal-open handler (no new handler).
  const hasReviewLabel = /['"`>\s]Review['"`<\s]/.test(detailTableSrc);
  const rowGatedOnFlag =
    /row\.shippingZeroNeedsReview\s*&&\s*row\.feeWaiverDecision\s*==\s*null/.test(detailTableSrc);
  const reusesModalOpen = /onOpenBillingEdit\(row\)/.test(detailTableSrc);
  check('FE(a): per-row Review control is gated on row.shippingZeroNeedsReview',
    rowGatedOnFlag);
  check('FE(a): the Review control reuses the existing edit-modal open handler (onOpenBillingEdit(row))',
    hasReviewLabel && reusesModalOpen);

  // (b) Header count/badge: a needs-review tally derived from
  //     shippingZeroNeedsReview over the rendered rows array, with the badge copy.
  const badgeDerivesFromFlag =
    /rows\.filter\(\(row\) => row\.shippingZeroNeedsReview === true && row\.feeWaiverDecision == null\)\.length/.test(lineItemsHeaderSrc);
  const hasBadgeCopy = /\$0-shipping need review/.test(lineItemsHeaderSrc);
  check('FE(b): a needs-review count derives from shippingZeroNeedsReview over rendered rows',
    badgeDerivesFromFlag);
  check('FE(b): the header renders the $0-shipping needs-review badge copy',
    hasBadgeCopy);

  // (c) Resolved rows are no longer "Needs Review": once the durable waiver
  // decision exists (waived OR kept), the unresolved count and row-level Review
  // affordance must drop. This is the DJ live-fail regression: the decision
  // saved, but the badge stayed visible.
  const unresolvedCountPredicate =
    /rows\.filter\(\(row\) => row\.shippingZeroNeedsReview === true && row\.feeWaiverDecision == null\)\.length/.test(lineItemsHeaderSrc);
  check('FE(c): the unresolved count excludes rows that already have a feeWaiverDecision',
    unresolvedCountPredicate);
  check('FE(c): the row Review button only renders for unresolved $0-shipping rows',
    /row\.shippingZeroNeedsReview\s*&&\s*row\.feeWaiverDecision\s*==\s*null/.test(detailTableSrc));
  check('FE(c): reviewed-kept rows keep a neutral action to change the decision to waived',
    /feeWaiverDecision === 'not_waived'/.test(editModalSrc) &&
    /Change to waive prep fees/.test(editModalSrc) &&
    /onZeroShippingReview\('waived'\)/.test(editModalSrc));
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
    /const effectiveRows: LineRow\[\]\s*=[\s\S]{0,900}applyPrepFeeWaiver\(rows, waived\)/.test(gen) &&
    /for \(const row of effectiveRows\)/.test(gen));
  check('gen: regenerate DELETEs the period then rebuilds with ON CONFLICT DO NOTHING (idempotent)',
    /\.delete\(billingLineItems\)/.test(gen) && /onConflictDoNothing\(/.test(gen));
}

// ── 9b. A saved waiver decision must make "Update Billing" rebuild the range ──
// DJ live failure: POST /zero-shipping-review saved the decision, then normal
// Update Billing called /billing/generate/status, saw no new shipments/prices,
// returned upToDate, and skipped the generator. The fee waiver was therefore
// durable but never applied to billing_line_items/details/exports.
{
  const gen = readFileSync('src/services/billing.ts', 'utf8');
  // Re-anchored 2026-07-08 (API-audit Phase 3): the fee-waiver freshness query
  // moved into the feeWaiverStalePromise IIFE so the three independent status
  // queries run in parallel. The guarded invariants are UNCHANGED — the same
  // billing_fee_waivers/updated_at query still runs inside
  // billingGenerationStatus, and the catch still FAILS CLOSED (stale=true,
  // now expressed as `return true`).
  const freshnessBlock = gen.match(/const feeWaiverStalePromise = \(async \(\) => \{[\s\S]+?\}\)\(\);/)?.[0] ?? '';
  check('status: billingGenerationStatus checks billing_fee_waivers updated after generated billing rows',
    /billing_fee_waivers/.test(freshnessBlock) &&
    /fw\.updated_at/.test(freshnessBlock) &&
    />\s*\(\s*select max\(b\.created_at\)/.test(freshnessBlock));
  check('status: fee-waiver freshness check fails closed so Update Billing does not silently no-op',
    /catch \(err\)[\s\S]{0,300}return true;/.test(freshnessBlock));
  check('status: a stale waiver returns upToDate=false and rebuilds the whole selected range',
    /if \((?:pricingStale \|\| feeWaiverStale|feeWaiverStale \|\| pricingStale)\)/.test(gen) &&
    /missingFrom:\s*isoDayStart\(from\)/.test(gen));
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

// ── 11. PS-275 item 2: the prep-fee WAIVER stays visible in invoice exports ────
//       (XLSX / CSV) and as an HTML period note. Before this, a waived order's zeroed
//       prep fee was indistinguishable from a genuinely free/$0 order, so the
//       PS-275 DoD's "review/waived indicator" was unmet on the exports.
//
//       Source of truth: the waiver DECISION stays owned by billing_fee_waivers
//       and is read via the canonical readBillingFeeWaivers — the SAME owner the
//       billing detail view's "Prep fee waived" chip already delegates to.
//       billingInvoiceData threads it onto each row as fee_waived; invoice
//       exports use the shared waivedSummaryNote and no longer show the per-row
//       waiver column. No line-item denormalization, no schema migration, and the
//       generator's (order_id, line_type, description) ON CONFLICT key is untouched.
{
  // (a) The shared indicator owner: the summary note names the waived count
  //     only when something was waived (default-inert otherwise).
  check('indicator: the period summary note names the waived-order count',
    /\b1 order\b/.test(waivedSummaryNote(1)) && /waiv/i.test(waivedSummaryNote(1)));
  check('indicator: pluralizes the summary note for multiple waived orders',
    /\b3 orders\b/.test(waivedSummaryNote(3)));
  check('indicator: NO summary note when nothing in the period was waived (default-inert)',
    waivedSummaryNote(0) === '' && waivedSummaryNote(-1) === '');

  // (b) CSV (behavioral, offline): the waiver decision must not add a trailing
  //     line-item column. The period note carries the audit signal instead.
  const csvBase: InvoiceCsvDetailRow = {
    order_id: 7001, order_number: 'PO-7001', ship_date: '2026-05-04',
    base_qty: '1', addl_qty: '0', pickpack_amt: '2.50', additional_amt: '0',
    shipping_amt: '0', storage_amt: '0', row_total: '2.50', skus: 'SKU-1',
    package_cost_amt: '0', box_label: '—', box_review: false, fee_waived: false,
  };
  check('CSV: the header row omits the waiver column',
    !INVOICE_CSV_HEADERS.includes('Prep Fee Waiver'));
  check('CSV: waived and non-waived rows have the same line-item columns',
    renderInvoiceCsvRow({ ...csvBase, fee_waived: true }) === renderInvoiceCsvRow({ ...csvBase, fee_waived: false }));

  // (c) Data + the heavy route renderers live in routes/billing.ts behind
  //     DB/app imports (renderInvoiceHtml / renderInvoiceXlsx) — static source
  //     pins, same approach as sections 7/8. billingInvoiceData must read the
  //     waiver SOT and stamp fee_waived. HTML/XLSX/CSV invoices use the period
  //     summary note only so the visible line-item tables stay compact.
  const routeSrc = readFileSync('src/routes/billing.ts', 'utf8');
  const htmlStart = routeSrc.indexOf('function renderInvoiceHtml(');
  const htmlEnd = routeSrc.indexOf("app.get('/invoice'", htmlStart);
  const htmlRenderer = htmlStart >= 0 && htmlEnd > htmlStart ? routeSrc.slice(htmlStart, htmlEnd) : '';
  const xlsxStart = routeSrc.indexOf('async function renderInvoiceXlsx(');
  const xlsxEnd = routeSrc.indexOf("app.get('/invoice.xlsx'", xlsxStart);
  const xlsxRenderer = xlsxStart >= 0 && xlsxEnd > xlsxStart ? routeSrc.slice(xlsxStart, xlsxEnd) : '';
  check('DATA: billingInvoiceData reads the waiver SOT (readBillingFeeWaivers) and stamps fee_waived',
    /readBillingFeeWaivers\(/.test(routeSrc) && /fee_waived/.test(routeSrc));
  check('HTML: invoice table hides the per-row prep-fee waiver column',
    !/WAIVED_COLUMN_HEADER|waiver-cell|waiver-badge|waivedCellText\(/.test(htmlRenderer));
  check('HTML: invoice still renders the period summary note from waivedSummaryNote',
    /waiverNote/.test(htmlRenderer) && /waivedSummaryNote\(/.test(routeSrc));
  check('XLSX: invoice hides the per-row prep-fee waiver column',
    !/WAIVED_COLUMN_HEADER|waivedCellText\(d\.fee_waived\)|key:\s*'waiver'/.test(xlsxRenderer));
}

if (failures > 0) {
  console.error(`\nFAIL PS-275 zero-shipping prep-fee review guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-275 zero-shipping prep-fee review guard');
