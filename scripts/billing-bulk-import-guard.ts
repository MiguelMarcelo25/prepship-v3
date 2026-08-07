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
  bulkImportRowsFromFields,
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

check('a space-separated line parses (typed by hand, not pasted)', () => {
  // The first real use typed "2555   12x10x3 20.72" instead of pasting tabs, and
  // the whole line became the order number.
  const rows = parseBulkImportText('2555   12x10x3 20.72');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.orderNumberRaw, '2555');
  assert.equal(rows[0]!.boxRaw, '12x10x3');
  assert.equal(rows[0]!.shippingRaw, '20.72');
});

check('a spaced box name survives space separation', () => {
  const rows = parseBulkImportText('2555 Custom 12x10x3 20.72');
  assert.equal(rows[0]!.orderNumberRaw, '2555');
  assert.equal(rows[0]!.boxRaw, 'Custom 12x10x3', 'the middle tokens are the box');
  assert.equal(rows[0]!.shippingRaw, '20.72');
});

check('space separation with no trailing amount is a box, not a shipping', () => {
  const rows = parseBulkImportText('2555 12x10x3');
  assert.equal(rows[0]!.boxRaw, '12x10x3');
  assert.equal(rows[0]!.shippingRaw, '');
});

check('a space-separated line resolves end to end', () => {
  const rows = resolveBulkImportRows(parseBulkImportText('2515 9x6x3 20.83'), DETAILS, PACKAGES);
  assert.equal(rows[0]!.status, 'ready');
  assert.equal(rows[0]!.orderId, 501);
  assert.equal(rows[0]!.packageId, 11);
  assert.equal(rows[0]!.shipping, 20.83);
});

check('grid fields resolve without any separator guessing', () => {
  const rows = resolveBulkImportRows(
    bulkImportRowsFromFields([
      { orderNumberRaw: '2515', boxRaw: '9x6x3', shippingRaw: '20.83' },
      { orderNumberRaw: ' 2521 ', boxRaw: ' 12x10x3 ', shippingRaw: ' $20.72 ' },
    ]),
    DETAILS,
    PACKAGES,
  );
  assert.equal(bulkImportReadyRows(rows).length, 2, 'both grid rows resolve');
  assert.equal(rows[1]!.shipping, 20.72, 'fields are trimmed');
});

check('a wholly empty grid row is ignored, not an error', () => {
  const rows = resolveBulkImportRows(
    bulkImportRowsFromFields([
      { orderNumberRaw: '2515', boxRaw: '9x6x3', shippingRaw: '20.83' },
      { orderNumberRaw: '', boxRaw: '', shippingRaw: '' },
    ]),
    DETAILS,
    PACKAGES,
  );
  assert.equal(rows.length, 1, 'the blank row produces no finding at all');
});

check('a grid row keeps its position so status maps back to it', () => {
  // The modal indexes status by lineNumber-1; a skipped blank row must not shift
  // later rows onto the wrong line.
  const parsed = bulkImportRowsFromFields([
    { orderNumberRaw: '', boxRaw: '', shippingRaw: '' },
    { orderNumberRaw: '2515', boxRaw: '9x6x3', shippingRaw: '20.83' },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.lineNumber, 2, 'row 2 reports as line 2, not line 1');
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

check('each row shows its own spinner, clears on success, keeps data on failure', () => {
  const modal = readFileSync('web/src/components/Views/BillingBulkImportModal.tsx', 'utf8');
  assert.match(
    modal,
    /setRowState\(\(current\) => \(\{ \.\.\.current, \[fieldId\]: \{ state: 'applying' \} \}\)\)/,
    'the row being written must show as applying',
  );
  // A saved row empties out so what is left on screen is only what still needs work.
  assert.match(
    modal,
    /state: 'done'[\s\S]{0,400}orderNumberRaw: '', boxRaw: '', shippingRaw: ''/,
    'a saved row must clear its inputs',
  );
  // A failed row must NOT be cleared, or the operator loses what to retry.
  const failBlock = modal.slice(modal.indexOf('} catch (err) {'), modal.indexOf('setProgress((current) => ({'));
  assert.doesNotMatch(failBlock, /orderNumberRaw: ''/, 'a failed row keeps its values');
  assert.match(modal, /state: 'failed', message/);
  assert.match(modal, /rowState\[field\.id\]\?\.state === 'applying'/, 'status cell renders the per-row spinner');
  assert.match(modal, /rowState\[field\.id\]\?\.state === 'done'/, 'status cell renders Saved');
});

check('editing an applied row clears its stale verdict', () => {
  // Otherwise a retyped row still reads Saved and could be skipped or double-applied.
  const modal = readFileSync('web/src/components/Views/BillingBulkImportModal.tsx', 'utf8');
  const update = modal.slice(modal.indexOf('function updateField'), modal.indexOf('function addField'));
  assert.match(update, /setRowState/);
  assert.match(update, /delete next\[id\]/);
});

check('the import defers read invalidation until the batch finishes', () => {
  // Invalidating after every PATCH refetched the whole billing range once per
  // row, which stalled an 85-row apply. The batch invalidates once at the end.
  const view = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');
  assert.match(view, /handleBulkImportRow[\s\S]{0,1700}deferReads: true/);
  assert.match(
    view,
    /handleBulkImportFinished[\s\S]{0,600}invalidateQueries/,
    'the batch must still refresh the reads once when it completes',
  );

  const client = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
  assert.match(
    client,
    /updateBillingDetail\([\s\S]{0,400}if \(!options\?\.deferReads\) invalidateBillingReads/,
    'single-edit callers must keep the eager invalidation',
  );
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
