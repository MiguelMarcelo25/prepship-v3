/**
 * PS — pasted Box Size / Shipping import.
 *
 * Pins the PURE resolution layer: what a paste turns into, and — more importantly —
 * what it REFUSES to turn into. Every `ready` row becomes a real invoice-line edit,
 * so a silent wrong match here is a silent wrong invoice.
 *
 * The write path itself is NOT re-tested here: the import calls the same audited
 * PATCH /billing/details/:orderId a manual edit uses, which already owns
 * finalized-invoice refusal, permissions and the before/after audit row.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseBulkImportText,
  parseImportMoney,
  resolveBulkImportRows,
  resolveImportPackage,
  bulkImportReadyRows,
} from '../web/src/components/Views/billing-bulk-import';

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

const PACKAGES = [
  { packageId: 11, name: '9x6x3' },
  { packageId: 12, name: '12x10x3' },
  { packageId: 13, name: 'Custom 12x10x3' },
  { packageId: 14, name: '8.5x8x5' },
];

const DETAILS = [
  { orderId: 501, orderNumber: '2515' },
  { orderId: 502, orderNumber: '2521' },
  { orderId: 503, orderNumber: '2547' },
];

check('a Google Sheets tab paste parses into order/box/shipping', () => {
  const rows = parseBulkImportText('2515\t9x6x3\t20.83\n2521\t12x10x3\t$20.72');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.orderNumberRaw, '2515');
  assert.equal(rows[0]!.boxRaw, '9x6x3');
  assert.equal(rows[1]!.shippingRaw, '$20.72');
});

check('a pasted header row is skipped, blank lines ignored', () => {
  const rows = parseBulkImportText('ORDER #\tBOX\tSHIPPING\n\n2515\t9x6x3\t20.83\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.orderNumberRaw, '2515');
});

check('money accepts $ and spaces, rejects anything else', () => {
  assert.equal(parseImportMoney('$20.83'), 20.83);
  assert.equal(parseImportMoney(' 20.72 '), 20.72);
  assert.equal(parseImportMoney('0'), 0);
  for (const bad of ['abc', '20.8.3', '-5', '', '1e3']) {
    assert.equal(parseImportMoney(bad), null, `"${bad}" must be refused`);
  }
});

check('a comma is only a thousands separator, never a decimal', () => {
  // "20,83" is the European decimal. Stripping commas blindly makes it 2083 — a
  // 100x overcharge on a real invoice.
  assert.equal(parseImportMoney('20,83'), null);
  assert.equal(parseImportMoney('1,23'), null);
  assert.equal(parseImportMoney('1,2345'), null);
  assert.equal(parseImportMoney('1,234.56'), 1234.56);
  assert.equal(parseImportMoney('1,234,567'), 1234567);
});

check('an exact box name wins over a longer partial match', () => {
  // "12x10x3" must NOT be ambiguous just because "Custom 12x10x3" contains it.
  const hit = resolveImportPackage('12x10x3', PACKAGES);
  assert.equal(hit.status, 'ok');
  assert.equal(hit.packageId, 12);
});

check('box matching ignores spaces and case', () => {
  assert.equal(resolveImportPackage('12 X 10 X 3', PACKAGES).packageId, 12);
  assert.equal(resolveImportPackage('8.5x8x5', PACKAGES).packageId, 14);
});

check('an unmatched box is reported, never guessed', () => {
  assert.equal(resolveImportPackage('99x99x99', PACKAGES).status, 'unknown');
  assert.equal(resolveImportPackage('', PACKAGES).status, 'unknown');
});

check('an ambiguous box refuses rather than picking one', () => {
  const ambiguous = resolveImportPackage('custom', [
    { packageId: 1, name: 'Custom 4x7x2' },
    { packageId: 2, name: 'Custom 8x7x2' },
  ]);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.packageId, null);
});

check('a clean paste resolves to ready rows with ids', () => {
  const rows = resolveBulkImportRows(
    parseBulkImportText('2515\t9x6x3\t20.83\n2521\t12x10x3\t20.72'),
    DETAILS,
    PACKAGES,
  );
  assert.equal(bulkImportReadyRows(rows).length, 2);
  assert.equal(rows[0]!.orderId, 501);
  assert.equal(rows[0]!.packageId, 11);
  assert.equal(rows[0]!.shipping, 20.83);
});

check('an order outside the loaded range is NOT ready', () => {
  const rows = resolveBulkImportRows(parseBulkImportText('9999\t9x6x3\t20.83'), DETAILS, PACKAGES);
  assert.equal(rows[0]!.status, 'unknown_order');
  assert.equal(bulkImportReadyRows(rows).length, 0);
});

check('a bad amount blocks the row instead of writing 0', () => {
  // Coercing "abc" to 0 would silently zero a shipping charge on a real invoice.
  const rows = resolveBulkImportRows(parseBulkImportText('2515\t9x6x3\tabc'), DETAILS, PACKAGES);
  assert.equal(rows[0]!.status, 'bad_shipping');
  assert.equal(bulkImportReadyRows(rows).length, 0);
});

check('the same order twice applies once and flags the repeat', () => {
  const rows = resolveBulkImportRows(
    parseBulkImportText('2515\t9x6x3\t20.83\n2515\t12x10x3\t30.00'),
    DETAILS,
    PACKAGES,
  );
  assert.equal(rows[0]!.status, 'ready');
  assert.equal(rows[1]!.status, 'duplicate');
  assert.equal(bulkImportReadyRows(rows).length, 1);
});

check('a blank column leaves that field alone', () => {
  const boxOnly = resolveBulkImportRows(parseBulkImportText('2515\t9x6x3\t'), DETAILS, PACKAGES);
  assert.equal(boxOnly[0]!.status, 'ready');
  assert.equal(boxOnly[0]!.shipping, null, 'blank shipping must not become 0');

  const shipOnly = resolveBulkImportRows(parseBulkImportText('2521\t\t20.72'), DETAILS, PACKAGES);
  assert.equal(shipOnly[0]!.status, 'ready');
  assert.equal(shipOnly[0]!.packageId, null, 'blank box must not clear the box');
});

check('a row with neither box nor shipping is not applied', () => {
  const rows = resolveBulkImportRows(parseBulkImportText('2515\t\t'), DETAILS, PACKAGES);
  assert.equal(rows[0]!.status, 'nothing_to_change');
  assert.equal(bulkImportReadyRows(rows).length, 0);
});

check('the import writes through the existing audited detail PATCH', () => {
  // Placement: no second write path for invoice-line money.
  const view = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');
  assert.match(
    view,
    /handleBulkImportRow[\s\S]{0,900}apiClient\.updateBillingDetail\(/,
    'the import must call the same detail PATCH a manual edit uses',
  );
  // No \n anchor here: these files are CRLF, so `reason,\n` never matches.
  assert.match(view, /handleBulkImportRow[\s\S]{0,1600}reason,/, 'every imported row carries a reason');
});

check('a pasted box takes that box\'s saved client price', () => {
  // Same rule as the manual Box Size change; otherwise an imported box keeps the
  // previous box's cost and the invoice is quietly wrong.
  const view = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');
  assert.match(
    view,
    /packageCost: row\.packageId != null && billingEditPackagePrices\[row\.packageId\] != null/,
  );
});

if (failures) {
  console.error(`\nFAIL billing bulk import guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS billing bulk import guard');
