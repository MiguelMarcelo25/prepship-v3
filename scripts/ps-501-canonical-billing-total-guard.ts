/**
 * PS-501 — one canonical billing total.
 *
 * THE DEFECT
 *
 * Billing rows carry three total-shaped fields and only two are synonyms:
 *
 *   grandTotal           the row's money. Backend-owned, canonical.
 *   total                the same value under the old name (`total: grandTotal`).
 *   fulfillmentFeeTotal  NOT a total — Pick & Pack + Additional Units + Box Cost only.
 *
 * Consumers resolved them as `grandTotal ?? total ?? fulfillmentFeeTotal`, which reads
 * like null-safety and is a silent substitution. On a real fixture row the numbers are
 * grandTotal $35.65 and fulfillmentFeeTotal $8.00, so a nullish grandTotal displayed the
 * customer's total as $8.00 with nothing on screen saying a fallback had happened.
 *
 * PS-505 fixed this same conflation on the backend after it rendered 12.44 instead of 4.49
 * on order #3074. This guard locks the consumer side so it cannot return.
 *
 * BEHAVIOURAL, not just textual: the contract functions are executed against legacy,
 * conflicting, null and zero payloads. A guard that only grepped for the cascade would
 * pass against a rewritten cascade that still picked by field order.
 *
 * Offline and pure — no database, no network, no mutation.
 */
import {
  BillingRowTotalContractError,
  canonicalRowGrandTotal,
  reconcileCategoryTotals,
} from '../src/services/billing-row-total-contract';
import {
  billingRowGrandTotalOrNull,
  resolveBillingRowGrandTotal,
} from '../web/src/lib/billing-row-total';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const strip = (src: string) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── AC-2 / AC-3 — the BACKEND contract, executed ─────────────────────────────
console.log('\nbackend contract (canonicalRowGrandTotal)');

check('a canonical row resolves to grandTotal',
  canonicalRowGrandTotal({ grandTotal: 35.65, total: 35.65, fulfillmentFeeTotal: 8 }, 'r1') === 35.65);

check('ZERO is a real total, not a missing one',
  canonicalRowGrandTotal({ grandTotal: 0, total: 0, fulfillmentFeeTotal: 0 }, 'r-zero') === 0);

check('a NEGATIVE total (a credit) survives',
  canonicalRowGrandTotal({ grandTotal: -12.5, total: -12.5 }, 'r-credit') === -12.5);

{
  // The defect, stated as a test: a nullish grandTotal must NOT fall through to a smaller
  // number. It must refuse.
  let threw: unknown = null;
  try {
    canonicalRowGrandTotal({ grandTotal: null, total: undefined, fulfillmentFeeTotal: 8 }, 'r-null');
  } catch (error) { threw = error; }
  check('a missing grandTotal REFUSES rather than substituting fulfillmentFeeTotal',
    threw instanceof BillingRowTotalContractError,
    threw === null ? 'it returned a number instead of throwing' : undefined);
  check('the refusal names fulfillmentFeeTotal as a different quantity',
    threw instanceof Error && /different quantity/i.test(threw.message));
}

{
  // AC-3 — field order must never pick the winner.
  let threw: unknown = null;
  try {
    canonicalRowGrandTotal({ grandTotal: 35.65, total: 8 }, 'r-conflict');
  } catch (error) { threw = error; }
  check('CONFLICTING aliases fail closed instead of preferring one by position',
    threw instanceof BillingRowTotalContractError,
    threw === null ? 'it silently preferred grandTotal instead of reporting the conflict' : undefined);
}

check('a legacy payload carrying only the old name is still refused (grandTotal is required)',
  (() => {
    try { canonicalRowGrandTotal({ total: 35.65 }, 'r-legacy'); return false; } catch { return true; }
  })());

check('sub-cent float drift is NOT treated as a conflict',
  canonicalRowGrandTotal({ grandTotal: 35.65, total: 35.6500001 }, 'r-drift') === 35.65);

// ── AC-4 — category totals must account for the whole row ────────────────────
console.log('\nAC-4 reconciliation (reconcileCategoryTotals)');

check('outbound-only categories reconcile',
  reconcileCategoryTotals(
    { pickPackTotal: 3.25, packageTotal: 4.75, shippingTotal: 11.5 }, 19.5, 'r-outbound') === null);

check('RETURN money is part of the reconciliation, not an exemption',
  reconcileCategoryTotals(
    { pickPackTotal: 3.25, packageTotal: 4.75, shippingTotal: 11.5, returnTotal: 16.15 },
    35.65, 'r-with-returns') === null);

{
  // The exact hole this closed: without a return bucket the categories summed to 19.50
  // against a grandTotal of 35.65 and the missing 16.15 belonged to nothing on screen.
  const complaint = reconcileCategoryTotals(
    { pickPackTotal: 3.25, packageTotal: 4.75, shippingTotal: 11.5 }, 35.65, 'r-missing-bucket');
  check('money belonging to NO bucket is reported, not rounded away',
    complaint !== null && /delta 16\.15/.test(complaint), complaint ?? 'it reported reconciled');
}

// ── AC-1 — the frontend resolver, executed ───────────────────────────────────
console.log('\nfrontend resolver (resolveBillingRowGrandTotal)');

check('resolves the canonical field',
  resolveBillingRowGrandTotal({ grandTotal: 35.65, total: 35.65, fulfillmentFeeTotal: 8 }).ok === true);

check('accepts the snake_case DEPLOY-SKEW spelling of the same field (PS-369)',
  billingRowGrandTotalOrNull({ grand_total: 35.65 }) === 35.65);

check('NEVER falls back to fulfillmentFeeTotal',
  billingRowGrandTotalOrNull({ fulfillmentFeeTotal: 8 }) === null);

check('a conflicting legacy alias is refused, not preferred by position',
  resolveBillingRowGrandTotal({ grandTotal: 35.65, total: 8 }).ok === false);

check('zero resolves as zero (not as "missing")',
  billingRowGrandTotalOrNull({ grandTotal: 0 }) === 0);

check('unresolvable returns NULL rather than 0, so it cannot sort or sum as free money',
  billingRowGrandTotalOrNull({ fulfillmentFeeTotal: 8, orderCount: 3 }) === null);

// ── AC-1 — sorting and display cannot disagree ───────────────────────────────
console.log('\nconsumers delegate (no cascade survives)');

const CONSUMERS = [
  'web/src/components/Views/BillingSummaryTable.tsx',
  'web/src/components/Views/BillingDetailClientStrip.tsx',
  'web/src/components/Views/BillingView.tsx',
  'web/src/components/Views/billing-parity.ts',
];

for (const file of CONSUMERS) {
  const code = strip(read(file));
  check(`${file.split('/').pop()} has no grandTotal -> total -> fulfillmentFeeTotal cascade`,
    !/grandTotal\s*\?\?[^\n]*\b(total|fulfillmentFee)/.test(code));
  check(`${file.split('/').pop()} delegates to the canonical resolver`,
    /billingRowGrandTotalOrNull\s*\(|resolveBillingRowGrandTotal\s*\(/.test(code));
}

{
  // Sorting by a different number than the cell displays is its own defect — it was
  // possible here because sortValue and render each ran the cascade independently.
  const table = strip(read('web/src/components/Views/BillingSummaryTable.tsx'));
  const sortUsesResolver = /sortValue:\s*\(row\)\s*=>\s*billingRowGrandTotalOrNull\(row\)/.test(table);
  const renderUsesResolver = /const resolved = resolveBillingRowGrandTotal\(row\)/.test(table);
  check('the Total column SORTS and RENDERS through the same resolver', sortUsesResolver && renderUsesResolver);
}

// ── AC-4 — every summary producer emits the return bucket ────────────────────
console.log('\nbackend producers emit returnTotal');

const billingSvc = read('src/services/billing.ts');
const metrics = read('src/services/reporting-metrics.ts');
// PS-515: the invoice header totals owner is the THIRD return-bucket producer (added by PS-514
// for the FE invoice summary categories). It must delegate to the same vocabulary owner, or a
// spelling added to BILLING_RETURN_LINE_TYPES reaches the live summary + cached metrics but
// silently misses the invoice summary, and the FE invoice category cards stop reconciling to
// grandTotal with no error.
const invoiceTotals = read('src/services/billing-invoice-totals.ts');

check('the live summary SQL has a return_total bucket', /as return_total/.test(billingSvc));
check('the zero-volume summary branch emits returnTotal', /returnTotal: 0,/.test(billingSvc));
check('the CACHED metrics read model emits returnTotal', /returnTotal,/.test(metrics));
check('the cached metrics upsert persists return_total',
  /return_total = excluded\.return_total/.test(metrics));
check('the invoice header totals owner has a return_total bucket', /as return_total/.test(invoiceTotals));
check('ALL THREE return-bucket producers come from the ONE vocabulary owner, not a hand-written list',
  /billingReturnLineTypesSql\(\)/.test(billingSvc)
  && /billingReturnLineTypesSql\(\)/.test(metrics)
  && /billingReturnLineTypesSql\(\)/.test(invoiceTotals));
check('the invoice header totals owner does NOT re-spell the return vocabulary inline',
  !/line_type in \('return'/.test(invoiceTotals));

{
  // A second hand-written list is exactly how return_processing_fee once went missing from
  // one projection while staying in another.
  const rowStatus = read('src/services/billing-row-status.ts');
  check('the return vocabulary is declared ONCE and the predicate derives from it',
    /export const BILLING_RETURN_LINE_TYPES/.test(rowStatus) &&
    /BILLING_RETURN_LINE_TYPES as readonly string\[\]\)\.includes/.test(rowStatus));

  // ── PS-517 — the SPLIT vocabulary has one owner too ────────────────────────
  //
  // The aggregate bucket above and the postage/processing SPLIT are different facts, and the
  // split had its own hand-written copies: the invoice DETAIL query spelled both lists out in
  // four SQL arms while the TS predicates spelled them out again. A spelling added to one and
  // missed in the other moves money BETWEEN the two named parts (or out of both) while
  // grand_total stays right — the row still foots, so nothing errors and nothing is caught.
  console.log('\nPS-517 split return vocabulary (postage vs processing)');
  const detailRoute = read('src/routes/billing.ts');

  check('both SPLIT vocabularies are declared ONCE as consts',
    /export const BILLING_RETURN_POSTAGE_LINE_TYPES/.test(rowStatus)
    && /export const BILLING_RETURN_PROCESSING_LINE_TYPES/.test(rowStatus));
  check('both SPLIT predicates derive from those consts, not inline spellings',
    /BILLING_RETURN_POSTAGE_LINE_TYPES as readonly string\[\]\)\.includes/.test(rowStatus)
    && /BILLING_RETURN_PROCESSING_LINE_TYPES as readonly string\[\]\)\.includes/.test(rowStatus));
  check('the owner exposes both SPLIT vocabularies as SQL',
    /export function billingReturnPostageLineTypesSql/.test(rowStatus)
    && /export function billingReturnProcessingLineTypesSql/.test(rowStatus));
  check('the invoice DETAIL query consumes the SQL owners',
    /billingReturnPostageLineTypesSql\(\)/.test(detailRoute)
    && /billingReturnProcessingLineTypesSql\(\)/.test(detailRoute));
  // The four arms this replaced: two amount sums + two bool_or presence flags.
  check('the invoice DETAIL query does NOT re-spell the split vocabulary inline',
    !/line_type in \('return_postage'/.test(detailRoute)
    && !/line_type in \('return_processing_fee'/.test(detailRoute));

  // The split buckets must stay SUBSETS of the aggregate. If a spelling is added to a split
  // list but not to BILLING_RETURN_LINE_TYPES, its money lands in a named part while dropping
  // out of the return total — the two owners disagreeing in the one way each is blind to.
  const listOf = (name: string): string[] => {
    const block = rowStatus.match(new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
    return block ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  };
  const all = listOf('BILLING_RETURN_LINE_TYPES');
  const postage = listOf('BILLING_RETURN_POSTAGE_LINE_TYPES');
  const processing = listOf('BILLING_RETURN_PROCESSING_LINE_TYPES');
  check('the split lists were parsed', all.length === 5 && postage.length === 2 && processing.length === 2,
    `all=${all.length} postage=${postage.length} processing=${processing.length}`);
  check('every SPLIT spelling is also in the aggregate return vocabulary',
    [...postage, ...processing].every((t) => all.includes(t)),
    `split=${[...postage, ...processing].join(',')} all=${all.join(',')}`);
  check('the two SPLIT buckets are disjoint',
    !postage.some((t) => processing.includes(t)));
}

// ── AC-5 — exports cannot diverge from what is displayed ─────────────────────
console.log('\nexport parity');

{
  // The three export buttons hand the BACKEND a client id and nothing else. No total
  // crosses that boundary, so an export physically cannot carry a frontend-derived number.
  const table = strip(read('web/src/components/Views/BillingSummaryTable.tsx'));
  const handlers = table.match(/handleExportInvoice\w*\(row\.clientId, row\.clientName\)/g) ?? [];
  check('invoice / Excel / CSV exports pass only clientId + clientName to the backend',
    handlers.length === 3, `found ${handlers.length} export handler calls`);
  check('no export handler is passed a total',
    !/handleExportInvoice\w*\([^)]*(grandTotal|fulfillmentFeeTotal|rowTotal)/.test(table));
}

console.log(`\n${failures === 0 ? 'PS-501 canonical billing total guard passed.' : `PS-501 canonical billing total guard FAILED with ${failures} failure(s).`}`);
if (failures > 0) process.exit(1);
