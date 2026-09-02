/**
 * PS-490 billing export Destination + Return indicator guard.
 *
 * Offline: the REAL classifier and the REAL CSV serializer. No DB, no provider.
 *
 * What this protects. "Is this destination international?" is a business rule that decides
 * an operator-facing money surface, so it has exactly one owner —
 * classifyDestinationCountry (billing-destination-international.ts, PS-488 AC-2, confirmed
 * by DJ 2026-08-05). The exports had no Destination column at all and their own read path,
 * so the risk when adding one is that an export re-derives "international" with a naive
 * `country !== 'US'`. That is the same trap PS-493 documents in insurance-cost.ts, and the
 * classifier's own header warns about it: Puerto Rico carries 'PR' and ships DOMESTIC.
 *
 * The other half: `Needs Review`. 293 production orders carry no country at all. AC-2 is
 * explicit that a gap must never render as Domestic — a missing country and a verified US
 * address must not look the same on an invoice.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INVOICE_COLUMN_HEADERS, invoiceColumnIndex } from '../src/routes/billing-invoice-columns';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const { classifyDestinationCountry } = await import('../src/services/billing-destination-international');
const { renderInvoiceCsv, INVOICE_CSV_HEADERS } = await import('../src/routes/billing-invoice-csv');

// ── the column exists, at the END ──────────────────────────────────────────
check('Destination is a CSV column', INVOICE_CSV_HEADERS.includes('Destination' as never));
// PS-488 M3 — this used to require Destination be the LAST header. The rule it was
// protecting is that Destination sits AFTER every column PS-490 inherited, so the
// positional assertions in ps-468 do not shift. "Last overall" expressed that only while
// PS-490 happened to be the most recent change; appending Return Postage / Return
// Processing behind it violates the literal while honouring the rule. Re-anchored to the
// rule: Destination comes after Shipment #, the last column that predates PS-490.
check('Destination is appended AFTER every pre-PS-490 column, so positions do not shift',
  INVOICE_CSV_HEADERS.indexOf('Destination' as never)
    > INVOICE_CSV_HEADERS.indexOf('Shipment #' as never),
  [...INVOICE_CSV_HEADERS]);

// ── the classification the export must render ──────────────────────────────
// PR/VI/GU are the whole point: they are NOT 'US' but they ship domestically.
for (const domestic of ['US', 'us', 'USA', 'United States', 'PR', 'VI', 'GU', 'AS', 'MP', 'UM']) {
  check(`${JSON.stringify(domestic)} is Domestic`,
    classifyDestinationCountry(domestic).destination === 'Domestic',
    classifyDestinationCountry(domestic));
}
for (const international of ['CA', 'GB', 'ca', 'MH']) {
  check(`${JSON.stringify(international)} is International`,
    classifyDestinationCountry(international).destination === 'International');
}
// A gap must be visibly a gap.
for (const unknown of [null, undefined, '', '   ', 'N/A', '-', '90210', 123]) {
  check(`${JSON.stringify(unknown)} is Needs Review, never Domestic`,
    classifyDestinationCountry(unknown).destination === 'Needs Review',
    classifyDestinationCountry(unknown));
}

// ── the serializer renders the owner's answer, in the right cell ───────────
const base = {
  order_id: 1, shipment_id: 11, ship_date: '2026-05-05', billing_effective_date: '2026-05-05',
  base_qty: '1', addl_qty: '0', pickpack_amt: '1', additional_amt: '0', shipping_amt: '0',
  storage_amt: '0', row_total: '1', skus: null, package_cost_amt: '0', box_label: 'S',
  box_review: false, fee_waived: false,
};
const csvFor = (over: Record<string, unknown>) =>
  renderInvoiceCsv([{ ...base, order_number: 'N1', ...over } as never]).split('\r\n')[1] ?? '';

// PS-488 M3 — these read the Destination CELL BY POSITION instead of asserting the row
// ends with it. endsWith() silently tested "Destination is the final column" as well as
// its real subject; once two columns were appended, all three failed without any of them
// having anything to do with returns. Reading the cell keeps each check on its own topic.
const DESTINATION_CELL = INVOICE_CSV_HEADERS.indexOf('Destination' as never);
const destinationCellFor = (over: Record<string, unknown>) => csvFor(over).split(',')[DESTINATION_CELL];

check('an International order renders International in the Destination cell',
  destinationCellFor({ destination: 'International' }) === 'International',
  csvFor({ destination: 'International' }));
check('a Needs Review order says so rather than rendering blank',
  destinationCellFor({ destination: 'Needs Review' }) === 'Needs Review');
check('an ADJUSTMENT has no destination and renders blank, not Needs Review',
  destinationCellFor({ destination: 'Needs Review', billing_adjustment_id: 'adj-12345678' }) === '',
  csvFor({ destination: 'Needs Review', billing_adjustment_id: 'adj-12345678' }));

// ── the Return indicator on the Order # cell ───────────────────────────────
check('the Order # cell carries the Return suffix the backend resolved',
  csvFor({ order_number_label: '0001 - Return' }).includes(',0001 - Return,'),
  csvFor({ order_number_label: '0001 - Return' }));
check('without a resolved label the plain order number is still emitted',
  csvFor({}).includes(',N1,'), csvFor({}));

// ── placement: the exports must not own the rule ───────────────────────────
const route = readFileSync('src/routes/billing.ts', 'utf8').replace(/\r\n/g, '\n');
const csvSrc = readFileSync('src/routes/billing-invoice-csv.ts', 'utf8').replace(/\r\n/g, '\n');

check('the export delegates to the canonical classifier',
  /classifyDestinationCountry\(r\.ship_to_country\)/.test(route));
check('the export delegates the Return test to isBillingReturnLineType',
  /lineTypes\.some\(isBillingReturnLineType\)/.test(route));
// The CSV checks above feed order_number_label directly, which proves the SERIALIZER
// renders it but never exercises the route's derivation. Pin the construction too, or the
// suffix could be dropped in routes/billing.ts with every other check still green.
check('the route actually builds the " - Return" suffix',
  /\$\{baseOrderNumber\} - Return/.test(route),
  'the Order # cell must gain the suffix when the order carries return lines');
check('adjustments never gain a Return suffix',
  /!r\.billing_adjustment_id && lineTypes\.some\(isBillingReturnLineType\)/.test(route));
// THE placement assertion. A naive country test anywhere in an export re-creates the
// PR bug the canonical owner exists to prevent (see PS-493 for the live instance).
for (const [label, src] of [['routes/billing.ts', route], ['billing-invoice-csv.ts', csvSrc]] as const) {
  check(`${label} does NOT re-derive "international" from a country comparison`,
    !/country\s*[!=]==?\s*['"]US['"]/.test(src),
    'use classifyDestinationCountry — PR is not US but ships domestically');
  check(`${label} does not hardcode a domestic country list`,
    !/DOMESTIC_COUNTRY_CODES\s*=/.test(src));
}
// Naming the owner in a comment is fine; CALLING it here would make the serializer a
// second classifier. Test for an invocation, not a mention.
check('the CSV serializer stays pure — it renders destination, never classifies it',
  !/classifyDestinationCountry\s*\(/.test(csvSrc));

// ── Destination's POSITION, now owned by the shared column contract ────────
//
// These three assertions used to scrape the XLSX's and the HTML's own hand-written column
// lists, and required Destination to sit AFTER the return columns — which is where the XLSX
// happened to have appended it. The three renderers now derive from ONE contract
// (billing-invoice-columns.ts), and in that contract Destination sits directly after
// Shipment #, which is where the HTML and the CSV always had it. The XLSX moved to match.
//
// What this guard actually protects is that Destination has ONE agreed position and that
// nothing shifted underneath it. That is now a property of the contract, so assert it there
// instead of re-scraping three lists that no longer exist.
const destinationIndex = invoiceColumnIndex('destination');
check('Destination sits directly after Shipment # in the shared column contract',
  destinationIndex === invoiceColumnIndex('shipmentId') + 1,
  `destination=${destinationIndex} shipmentId=${invoiceColumnIndex('shipmentId')}`);
check('Destination comes before the AC-6 return columns, as the HTML and CSV always had it',
  destinationIndex < invoiceColumnIndex('returnPostage'),
  INVOICE_COLUMN_HEADERS.join(' | '));
// The three artifacts share one list, so "all three agree about Destination" is true by
// construction here. It is asserted on the RENDERED documents by
// test:ps-520-invoice-routes-pg17, which compares the actual header rows of all three.
check('the XLSX renders the shared contract rather than its own column list',
  /invoice\.columns = INVOICE_COLUMNS\.map/.test(route),
  'a second hand-written column list is how the three exports drifted apart');

assert.ok(true);
if (failures > 0) {
  console.error(`\nFAIL PS-490 billing export destination guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-490 billing export destination guard');
