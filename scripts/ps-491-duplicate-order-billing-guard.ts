/**
 * PS-491 duplicate-order billing guard.
 *
 * Offline: the REAL classifier and the REAL loader, executed rather than described.
 * No provider, no postage, no production, no customer order read.
 *
 * What this protects. The same marketplace order can land in `orders` twice, because
 * de-duplication is keyed on a `source_order_id` that ShipStation reassigns when an order
 * is edited. The invoice export groups by `order_id`, so both copies became invoice rows
 * and the customer was charged twice. Measured 2026-08-07: 369 duplicated order-number
 * groups, $347.60 of duplicate billing staged, none invoiced yet.
 *
 * THE assertion is the split-shipment one. Of the 72 groups where two copies each carry
 * paid shipping, 72 of 72 have two distinct tracking numbers — two labels, two real
 * shipments. A naive "one order number = one charge" would erase ~$1,348 of legitimate
 * postage revenue. If that check ever goes false, this fix starts undercharging.
 */
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL ??= 'postgres://user:pass@127.0.0.1:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service';
process.env.SUPABASE_JWT_SECRET ??= 'secret';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const {
  classifyDuplicateOrderCopies,
  duplicateOrderStatusLabel,
  isNonBillableDuplicate,
} = await import('../src/services/billing-duplicate-order-policy');
const { loadDuplicateOrderDecisions, nonBillableDuplicateOrderIds } =
  await import('../src/services/billing-duplicate-order-loader');

type Row = {
  orderId: number | null;
  orderNumber: string | null;
  shippingAmount: number;
  shipmentId: number | null;
  billingAdjustmentId: string | null;
};
const row = (o: Partial<Row> & { orderId: number | null; orderNumber: string | null }): Row => ({
  shippingAmount: 0, shipmentId: null, billingAdjustmentId: null, ...o,
});

// ── the ordinary case ───────────────────────────────────────────────────────
check('a single order for an order number produces no decision at all',
  classifyDuplicateOrderCopies([row({ orderId: 1, orderNumber: '1000', shippingAmount: 9 })]).size === 0);

// ── bucket A: exactly one copy carries paid shipping ────────────────────────
{
  const d = classifyDuplicateOrderCopies([
    row({ orderId: 1451458, orderNumber: '2256', shippingAmount: 49.92, shipmentId: 7 }),
    row({ orderId: 1470091, orderNumber: '2256', shippingAmount: 0 }),
  ]);
  check('A: the copy carrying paid shipping is authoritative',
    d.get(1451458)?.kind === 'authoritative', d.get(1451458));
  const dup = d.get(1470091);
  check('A: the other copy is a duplicate pointing at the paid copy',
    dup?.kind === 'duplicate' && dup.duplicateOfOrderId === 1451458, dup);
  check('A: the duplicate is non-billable', isNonBillableDuplicate(dup));
  check('A: the authoritative copy is billable', !isNonBillableDuplicate(d.get(1451458)));
  check('A: the invoice note names the surviving order',
    duplicateOrderStatusLabel(dup!) === 'Duplicate of order 1451458', duplicateOrderStatusLabel(dup!));
}

// Order of appearance must not decide the outcome — the paid copy wins from either side.
{
  const d = classifyDuplicateOrderCopies([
    row({ orderId: 900, orderNumber: 'X', shippingAmount: 0 }),
    row({ orderId: 100, orderNumber: 'X', shippingAmount: 12.5, shipmentId: 3 }),
  ]);
  check('A: paid shipping beats a LOWER order id (ranking is not id-first)',
    d.get(100)?.kind === 'authoritative' && d.get(900)?.kind === 'duplicate', [d.get(100), d.get(900)]);
}

// ── THE assertion — bucket C: two real labels must not be collapsed ─────────
{
  const d = classifyDuplicateOrderCopies([
    row({ orderId: 10, orderNumber: 'S', shippingAmount: 8.10, shipmentId: 1 }),
    row({ orderId: 11, orderNumber: 'S', shippingAmount: 9.40, shipmentId: 2 }),
  ]);
  check('C: two copies with paid shipping are a SPLIT SHIPMENT, never a duplicate',
    d.get(10)?.kind === 'split_shipment' && d.get(11)?.kind === 'split_shipment', [d.get(10), d.get(11)]);
  check('C: neither copy is suppressed, so no postage revenue is erased',
    !isNonBillableDuplicate(d.get(10)) && !isNonBillableDuplicate(d.get(11)));
  check('C: the invoice says why both rows are there',
    duplicateOrderStatusLabel(d.get(10)!) === 'Split shipment — review');
}

// ── bucket B: no copy carries paid shipping ────────────────────────────────
{
  const d = classifyDuplicateOrderCopies([
    row({ orderId: 55, orderNumber: 'B', shippingAmount: 0 }),
    row({ orderId: 22, orderNumber: 'B', shippingAmount: 0, shipmentId: 4 }),
  ]);
  check('B: with no paid shipping, the copy that HAS a shipment wins',
    d.get(22)?.kind === 'authoritative' && d.get(55)?.kind === 'duplicate', [d.get(22), d.get(55)]);
}
{
  const d = classifyDuplicateOrderCopies([
    row({ orderId: 77, orderNumber: 'B2' }),
    row({ orderId: 33, orderNumber: 'B2' }),
  ]);
  check('B: with no evidence at all the choice is deterministic (lowest id)',
    d.get(33)?.kind === 'authoritative' && d.get(77)?.kind === 'duplicate', [d.get(33), d.get(77)]);
}

// ── multi-package orders ───────────────────────────────────────────────────
// One order spanning several rows must be summed BEFORE ranking, or a two-package order
// looks like two weak candidates instead of one strong one.
{
  const d = classifyDuplicateOrderCopies([
    row({ orderId: 1, orderNumber: 'M', shippingAmount: 5, shipmentId: 1 }),
    row({ orderId: 1, orderNumber: 'M', shippingAmount: 6, shipmentId: 2 }),
    row({ orderId: 2, orderNumber: 'M', shippingAmount: 0 }),
  ]);
  check('a multi-package order counts as ONE copy, not two competing ones',
    d.get(1)?.kind === 'authoritative' && d.get(2)?.kind === 'duplicate', [d.get(1), d.get(2)]);
  check('a multi-package order is not mistaken for a split shipment',
    d.get(1)?.kind !== 'split_shipment');
}

// ── things that must never participate ─────────────────────────────────────
check('client-level adjustments are never duplicates',
  classifyDuplicateOrderCopies([
    row({ orderId: 1, orderNumber: 'A', billingAdjustmentId: 'adj-1' }),
    row({ orderId: 2, orderNumber: 'A', billingAdjustmentId: 'adj-2' }),
  ]).size === 0);
check('rows without an order id are ignored',
  classifyDuplicateOrderCopies([
    row({ orderId: null, orderNumber: 'A' }), row({ orderId: null, orderNumber: 'A' }),
  ]).size === 0);
check('rows without an order number are ignored (blank is not a shared identity)',
  classifyDuplicateOrderCopies([
    row({ orderId: 1, orderNumber: '' }), row({ orderId: 2, orderNumber: '  ' }),
  ]).size === 0);

// ── the loader: already-invoiced copies are untouchable ────────────────────
// Suppressing a copy that has already been invoiced would retroactively restate an
// invoice the customer has received. That must never happen, whatever the rule says.
const executor = (rows: unknown[]) => ({ execute: async () => rows as never });
{
  const decisions = await loadDuplicateOrderDecisions(1, '2026-07-01', '2026-08-01',
    executor([
      { order_id: 1, order_number: '2256', shipping_amt: '49.92', shipment_id: 7, billing_adjustment_id: null, invoiced_lines: 0 },
      { order_id: 2, order_number: '2256', shipping_amt: '0', shipment_id: null, billing_adjustment_id: null, invoiced_lines: 0 },
    ]));
  check('loader: an un-invoiced duplicate IS suppressed',
    nonBillableDuplicateOrderIds(decisions).join() === '2', [...decisions]);
}
{
  const decisions = await loadDuplicateOrderDecisions(1, '2026-07-01', '2026-08-01',
    executor([
      { order_id: 1, order_number: '2256', shipping_amt: '49.92', shipment_id: 7, billing_adjustment_id: null, invoiced_lines: 0 },
      { order_id: 2, order_number: '2256', shipping_amt: '0', shipment_id: null, billing_adjustment_id: null, invoiced_lines: 1 },
    ]));
  check('loader: an ALREADY-INVOICED copy is never suppressed, so no invoice is restated',
    nonBillableDuplicateOrderIds(decisions).length === 0, [...decisions]);
}
{
  const decisions = await loadDuplicateOrderDecisions(1, '2026-07-01', '2026-08-01', executor([]));
  check('loader: an empty period suppresses nothing', decisions.size === 0);
}

// ── placement: the rule lives in the owner, and both money paths use it ────
const totalsSrc = readFileSync('src/services/billing-invoice-totals.ts', 'utf8').replace(/\r\n/g, '\n');
const routeSrc = readFileSync('src/routes/billing.ts', 'utf8').replace(/\r\n/g, '\n');
const policySrc = readFileSync('src/services/billing-duplicate-order-policy.ts', 'utf8').replace(/\r\n/g, '\n');

check('the canonical totals owner builds a suppression predicate',
  /nonBillableDuplicateOrderIds/.test(totalsSrc) && /b\.order_id <> all/.test(totalsSrc));
// Building the predicate is not the same as USING it. Assert the interpolation appears
// inside the totals query itself — an earlier version of this check passed while the
// exclusion had been removed from the SQL, because the unused fragment still matched.
check('the totals QUERY actually applies the suppression, so finalization cannot snapshot a different amount',
  /and \$\{effectiveDay\} < \$\{dateTo\}::timestamptz\s*\n\s*\$\{notSuppressed\}/.test(totalsSrc),
  'the ${notSuppressed} fragment must be interpolated into the where clause');
check('the export delegates to the owner instead of re-deriving the rule',
  /loadDuplicateOrderDecisions/.test(routeSrc) && /isNonBillableDuplicate/.test(routeSrc));
check('the export does NOT contain its own duplicate rule (PS-316: one owner)',
  !/split_shipment/.test(routeSrc), 'routes/billing.ts must not classify duplicates itself');
check('the export and the totals share ONE load, so they cannot disagree',
  /billingInvoiceHeaderTotals\(\s*clientId, dateFrom, dateTo, db, duplicateDecisions,?\s*\)/.test(routeSrc));

// The decisions parameter is REQUIRED, not optional. This is the real protection against
// a future caller silently getting un-suppressed totals: TypeScript refuses to compile
// it. An optional parameter (`duplicateDecisions?:`) would restore that hole, so the
// absence of the `?` is pinned here.
check('the totals owner REQUIRES duplicate decisions, so a new caller cannot skip them',
  /duplicateDecisions: DuplicateOrderDecisions,/.test(totalsSrc)
  && !/duplicateDecisions\?:/.test(totalsSrc),
  'making the parameter optional would let a caller silently double-bill');
// Mentioning the loader in a comment is fine; CALLING it is what re-hides the dependency.
check('the totals owner does not hide a query inside itself',
  !/await\s+loadDuplicateOrderDecisions\s*\(/.test(totalsSrc),
  'loading inside the owner broke three reduced-schema fixtures and hid the dependency');

// The close workflow is the path that stamps invoiced = true. If it snapshots an
// unsuppressed total, the customer is billed twice no matter what the export shows.
const finalizeSrc = readFileSync('src/services/billing-finalization-policy.ts', 'utf8').replace(/\r\n/g, '\n');
check('the close workflow suppresses duplicates before snapshotting the finalized total',
  /loadDuplicateOrderDecisions\(\s*input\.clientId, input\.dateFrom, input\.dateTo, tx\s*\)/.test(finalizeSrc));
check('the close workflow loads on its OWN transaction, not a fresh connection',
  /loadDuplicateOrderDecisions\([^)]*\btx\b[^)]*\)/.test(finalizeSrc),
  'a non-tx read could miss a concurrent invoiced stamp');

// Every money column of a suppressed row must be zeroed together, or row_total stops
// agreeing with its own components.
for (const column of [
  'pickpack_amt', 'additional_amt', 'shipping_amt', 'storage_amt',
  'return_postage_amt', 'return_processing_amt', 'row_total', 'package_cost_amt',
]) {
  check(`export zeroes ${column} on a suppressed copy`,
    new RegExp(`${column}: suppressed \\? zero :`).test(routeSrc));
}
check('the suppressed row is still EMITTED, not dropped (a vanished order is not evidence)',
  !/\.filter\([^)]*isNonBillableDuplicate/.test(routeSrc));
check('the split-shipment branch is in the policy owner, where it can be tested',
  /paid\.length > 1/.test(policySrc));

if (failures > 0) {
  console.error(`\nFAIL PS-491 duplicate order billing guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-491 duplicate order billing guard');
