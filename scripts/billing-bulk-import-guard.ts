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
  bulkImportReasonFor,
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

check('the Box Size list closes on an outside click, without discarding the edit', () => {
  const modal = readFileSync('web/src/components/Views/BillingEditDetailModal.tsx', 'utf8');
  // CAPTURE phase: the modal container calls stopPropagation on mousedown, so a
  // bubble-phase document listener never sees clicks inside the modal and the
  // list stayed open when the operator clicked Shipping or Reason.
  assert.match(
    modal,
    /document\.addEventListener\('mousedown', onDocMouseDown, true\)/,
    'the outside-click listener must be capture phase',
  );
  assert.match(
    modal,
    /document\.removeEventListener\('mousedown', onDocMouseDown, true\)/,
    'and must be removed with the same capture flag or it leaks',
  );
  // Dismissing the list must not also close the edit modal and lose the draft.
  assert.match(
    modal,
    /!target\.closest\('\.billing-edit-modal'\)[\s\S]{0,120}stopPropagation\(\)/,
    'a backdrop click closes the list only',
  );
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

// ---------------------------------------------------------------------------
// PS-498 — per-row Description.
// ---------------------------------------------------------------------------

check('a tab paste carries a fourth Description column', () => {
  const rows = parseBulkImportText('2515\t9x6x3\t20.83\tDHL eCommerce to Gatineau');
  assert.equal(rows[0]!.descriptionRaw, 'DHL eCommerce to Gatineau');
  assert.equal(rows[0]!.boxRaw, '9x6x3', 'the box must not absorb the description');
  assert.equal(rows[0]!.shippingRaw, '20.83');
});

check('an extra tab inside the description does not truncate it', () => {
  // cells.slice(3).join(' ') rather than cells[3]: a stray tab typed mid-sentence
  // would otherwise silently drop everything after it.
  const rows = parseBulkImportText('2515\t9x6x3\t20.83\tDHL eCommerce\tto Gatineau');
  assert.equal(rows[0]!.descriptionRaw, 'DHL eCommerce to Gatineau');
});

check('a comma paste keeps commas INSIDE the description', () => {
  // Only the first three commas separate. Slicing the original string also keeps
  // the interior spacing exactly as typed.
  const rows = parseBulkImportText('2515, 9x6x3, 20.83, Canada re-ship, external Unishippers cost');
  assert.equal(rows[0]!.descriptionRaw, 'Canada re-ship, external Unishippers cost');
  assert.equal(rows[0]!.boxRaw, '9x6x3');
  assert.equal(rows[0]!.shippingRaw, '20.83');
});

check('a three-field line still parses byte-identically', () => {
  for (const line of ['2515,9x6x3,20.83', '2515\t9x6x3\t20.83']) {
    const rows = parseBulkImportText(line);
    assert.equal(rows[0]!.descriptionRaw, '', `${line} must yield no description`);
    assert.equal(rows[0]!.boxRaw, '9x6x3');
    assert.equal(rows[0]!.shippingRaw, '20.83');
  }
});

check('a space-separated line REFUSES rather than guessing a description', () => {
  // "Canada re-ship" is indistinguishable from the box "Custom 12x10x3", so any
  // heuristic here could write the wrong box onto a real invoice. Both token
  // orderings must refuse, and neither may produce a description.
  for (const line of ['2515 12x10x3 20.72 Canada re-ship', '2515 12x10x3 Canada re-ship 20.72']) {
    const parsed = parseBulkImportText(line);
    assert.equal(parsed[0]!.descriptionRaw, '', `${line} must not invent a description`);
    const rows = resolveBulkImportRows(parsed, DETAILS, PACKAGES);
    assert.equal(rows[0]!.status, 'unknown_box', `${line} must refuse`);
    assert.equal(bulkImportReadyRows(rows).length, 0);
  }
});

check('a description is trimmed and carried onto the ready row', () => {
  const rows = resolveBulkImportRows(
    bulkImportRowsFromFields([
      { orderNumberRaw: '2515', boxRaw: '', shippingRaw: '20.83', descriptionRaw: '  Canada re-ship  ' },
    ]),
    DETAILS,
    PACKAGES,
  );
  assert.equal(rows[0]!.status, 'ready');
  assert.equal(rows[0]!.description, 'Canada re-ship');
});

check('a description under 3 characters blocks the row instead of 400ing later', () => {
  // The description BECOMES the row's reason, and the API's reason is min(3). Left
  // unchecked this returns a server error about a "reason" the operator never typed.
  const rows = resolveBulkImportRows(
    bulkImportRowsFromFields([
      { orderNumberRaw: '2515', boxRaw: '', shippingRaw: '20.83', descriptionRaw: 'ab' },
    ]),
    DETAILS,
    PACKAGES,
  );
  assert.equal(rows[0]!.status, 'bad_description');
  assert.equal(bulkImportReadyRows(rows).length, 0);
});

check('a description alone is NOT an invoice edit', () => {
  // Applying it would re-send the whole line and mint durable manual overrides for
  // three line types that did not previously exist — an annotation becoming three
  // pinned amounts that survive regeneration.
  const rows = resolveBulkImportRows(
    bulkImportRowsFromFields([
      { orderNumberRaw: '2515', boxRaw: '', shippingRaw: '', descriptionRaw: 'Canada re-ship' },
    ]),
    DETAILS,
    PACKAGES,
  );
  assert.equal(rows[0]!.status, 'nothing_to_change');
  assert.match(rows[0]!.detail, /description alone/i, 'the detail must say why, not just "no box"');
  assert.equal(bulkImportReadyRows(rows).length, 0);
});

check('a wholly blank row is still ignored, but a description-only row is not', () => {
  assert.equal(
    bulkImportRowsFromFields([
      { orderNumberRaw: '', boxRaw: '', shippingRaw: '', descriptionRaw: '' },
    ]).length,
    0,
    'a blank line is the operator\'s spacing, not an error',
  );
  // Without descriptionRaw in the emptiness test, text the operator just typed
  // vanishes from the grid with no status shown at all.
  const typed = bulkImportRowsFromFields([
    { orderNumberRaw: '', boxRaw: '', shippingRaw: '', descriptionRaw: 'Canada re-ship' },
  ]);
  assert.equal(typed.length, 1);
  assert.equal(typed[0]!.lineNumber, 1);
});

check('the row description wins over the shared reason, and gates Apply', () => {
  const described = { description: 'Canada re-ship' };
  const bare = { description: '' };
  assert.equal(bulkImportReasonFor(described, ''), 'Canada re-ship', 'own description needs no fallback');
  assert.equal(
    bulkImportReasonFor(described, 'Bulk shipping correction'),
    'Canada re-ship',
    'the shared reason must never override a row that has its own',
  );
  assert.equal(bulkImportReasonFor(bare, 'ab'), null, 'a too-short shared reason blocks the row');
  assert.equal(bulkImportReasonFor(bare, '  Bulk shipping correction  '), 'Bulk shipping correction');
});

check('the Apply gate and the send path use the SAME reason function', () => {
  // Two expressions drift: a gate that disagrees with the send path either blocks
  // work that would succeed, or sends a request rejected for an invisible reason.
  const modal = readFileSync('web/src/components/Views/BillingBulkImportModal.tsx', 'utf8');
  assert.match(modal, /const canApply = [\s\S]{0,120}blockedLineNumbers\.size === 0/);
  assert.doesNotMatch(
    modal,
    /const canApply = [\s\S]{0,160}reason\.trim\(\)\.length >= 3/,
    'the inline length rule must be gone, not duplicated beside the function',
  );
  assert.match(modal, /onApplyRow\(row, bulkImportReasonFor\(row, reason\)/);
  assert.match(modal, /blockedLineNumbers[\s\S]{0,200}bulkImportReasonFor\(row, reason\) == null/);
});

check('the import sends the description only when the row carries one', () => {
  // Omitting the key is what tells the backend to leave a stored description
  // alone. Sending '' would be rejected, and sending the reason would clobber.
  const view = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');
  const block = view.slice(
    view.indexOf('async function handleBulkImportRow'),
    view.indexOf('async function handleBulkImportFinished'),
  );
  assert.ok(block.length > 400, 'handleBulkImportRow slice is empty or truncated — negatives below would pass vacuously');
  assert.match(block, /\.\.\.\(row\.description \? \{ orderDescription: row\.description \} : \{\}\)/);
  assert.doesNotMatch(block, /orderDescription: reason/, 'the description must never be the reason');
  assert.doesNotMatch(block, /orderDescription: ''/, 'never send an explicit blank');
});

check('the Edit Billing Detail modal shows the description READ-ONLY', () => {
  const modal = readFileSync('web/src/components/Views/BillingEditDetailModal.tsx', 'utf8');
  assert.match(modal, /row\.orderDescriptionSavedBy/, 'attribution must render');
  assert.match(modal, /row\.orderDescriptionSavedAt/, 'timestamp must render');
  // Read-only means read-only: no input binding, no draft field, no onChange.
  assert.doesNotMatch(modal, /value=\{[^}]*orderDescription/, 'must not be bound to an input');
  assert.doesNotMatch(modal, /onDraftChange\('orderDescription'/, 'must not be editable');

  const cache = readFileSync('web/src/components/Views/billing-edit-draft-cache.ts', 'utf8');
  assert.doesNotMatch(
    cache,
    /orderDescription/i,
    'prefilling Reason from a saved description makes an old reason the reason for a NEW edit',
  );
  assert.match(cache, /reason: ''/, 'the reason field must still start empty');
});

check('the description does NOT leak into the billing table or the exports', () => {
  // Scope was explicitly "Edit Billing Detail only".
  const parity = readFileSync('web/src/components/Views/billing-parity.ts', 'utf8');
  assert.doesNotMatch(parity, /orderDescription/i, 'no billing detail column');
  const table = readFileSync('web/src/components/Views/BillingDetailTable.tsx', 'utf8');
  assert.doesNotMatch(table, /orderDescription/i, 'no table cell');
  const csv = readFileSync('src/routes/billing-invoice-csv.ts', 'utf8');
  assert.doesNotMatch(csv, /orderDescription/i, 'operator notes must not reach a customer invoice');
});

check('the route delegates the write decision to the owner', () => {
  // The only source-text assertion left, because standing the full PATCH up under
  // PGlite (auth, clients, line items, finalization, audit) is out of scope. The
  // POLICY it could hide has been moved into billing-order-descriptions.ts, which
  // the behavioural guard executes — so the residual risk is "silently stops
  // persisting", not "silently overwrites".
  const route = readFileSync('src/routes/billing.ts', 'utf8');
  const start = route.indexOf("app.patch('/details/:orderId");
  // Line-ending agnostic on purpose: a literal '\r\n' anchor is how this repo has
  // already produced silent false passes more than once.
  const tail = start >= 0 ? route.slice(start) : '';
  const endOffset = tail.search(/app\.post\(\s*'\/box-cost\/bulk\/preview'/);
  const block = start >= 0 && endOffset > 0 ? tail.slice(0, endOffset) : '';
  assert.ok(block.length > 2000, 'PATCH slice is empty or truncated — the negatives below would pass vacuously');
  assert.match(block, /applyBillingOrderDescriptionPatch\(/, 'the route must call the owner');
  assert.match(block, /orderDescription: body\.orderDescription,[\s\S]{0,200}\},\s*tx,/, 'the write must run on the transaction');
  assert.doesNotMatch(
    block,
    /orderDescription: body\.orderDescription \?\?/,
    'no fallback may be applied before the owner sees it',
  );
  // The sibling note columns must keep their own lifecycle, untouched.
  assert.match(block, /body\.note \?\? `\$\{body\.reason\}/, 'billing_manual_overrides.note keeps its reason synthesis');
  // Scope to the box upsert's own set{} block. A slice running to the end of the
  // PATCH would swallow the description write that legitimately follows it and
  // report a false failure — the mirror of the vacuous-pass problem above.
  const boxUpsertStart = block.indexOf('.insert(billingBoxResolutions)');
  const boxUpsert = boxUpsertStart >= 0 ? block.slice(boxUpsertStart, boxUpsertStart + 900) : '';
  assert.ok(boxUpsert.includes('onConflictDoUpdate'), 'box-resolution upsert slice missed its set block');
  assert.doesNotMatch(boxUpsert, /orderDescription/, 'the box-resolution upsert must never touch the description');
});

check('the description schema rejects a blank rather than treating it as a clear', () => {
  const route = readFileSync('src/routes/billing.ts', 'utf8');
  assert.match(
    route,
    /orderDescription: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(500\)\.optional\(\)/,
    'optional (absent = leave alone) but min(1) (blank = 400, never a silent clear)',
  );
});

if (failures) {
  console.error(`\nFAIL billing bulk import guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS billing bulk import guard');
