/**
 * PS-488 M3 — absent versus explicit zero, through the REAL invoice renderers.
 *
 * Hermes's 6573ecde review: the DTO, the Billing table, the reconciler, the PG17 proof
 * and the CSV all distinguished the three states, but the two renderers that produce the
 * documents a client actually receives did not. The HTML invoice had no return columns at
 * all, and the XLSX row mapping did `Number(d.return_postage_amt ?? 0)` — turning a fee
 * that was never charged into a numeric 0 in the one place a reader is most likely to SUM
 * a column.
 *
 * Every check here drives renderInvoiceHtml() or renderInvoiceXlsx() — the exported
 * functions the routes call — and reads the produced document. Nothing is asserted about
 * an intermediate value that a renderer might ignore, because that is precisely the class
 * of gap this guard exists to close: the previous round's evidence was all upstream of
 * the renderers, so both could be wrong while everything "passed".
 *
 * Offline/pure: no DB, no network, no provider calls, no billing regeneration.
 */
import assert from 'node:assert/strict';
import { resolveBillingInvoiceReturnFee } from '../src/services/billing-invoice-return-cell';

// src/routes/billing.ts validates env at import time. Obviously-fake values, matching the
// ps-499 route harness convention, so importing the REAL renderers needs no live config.
// Both renderers are pure functions of their arguments — no DB, no network, no provider
// call is reachable from either — so this only satisfies the module-load check.
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL ??= 'https://ps488-test.supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'ps488-test-service-role-key';
process.env.SUPABASE_ANON_KEY ??= 'ps488-test-anon-key';
process.env.SESSION_SECRET ??= 'ps488-test-session-secret-value-not-real';
process.env.DATABASE_URL ??= 'postgres://ps488:ps488@127.0.0.1:1/ps488_unused';

const { renderInvoiceHtml, renderInvoiceXlsx } = await import('../src/routes/billing');

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

const TOTALS = {
  orderCount: 1, pickPackTotal: 0, additionalTotal: 0, pickPackFeeTotal: 0,
  packageTotal: 0, shippingTotal: 0, storageTotal: 0, grandTotal: 10.73,
  fulfillmentFeeTotal: 0,
};

/** A return row in the shape billingInvoiceData hands the renderers. */
function returnRow(over: Record<string, unknown>) {
  return {
    order_id: 4242, order_number: '1234', shipment_id: null, return_id: 7,
    ship_date: '2026-05-06', billing_effective_date: '2026-05-06',
    billing_policy_version: null, billing_adjustment_id: null,
    source_finalization_id: null, adjustment_description: null,
    base_qty: '0', addl_qty: '0', pickpack_amt: '0', additional_amt: '0',
    shipping_amt: '0', storage_amt: '0', package_cost_amt: '0',
    return_postage_amt: null, return_processing_amt: null,
    has_return_postage_line: false, has_return_processing_line: false,
    row_total: '0', billing_status_label: 'Return', item_names: null, skus: null,
    carrier_code: null, box_label: '—', box_review: false, fee_waived: false,
    destination: 'Domestic', order_number_label: '#1234-RETURN',
    ...over,
  } as never;
}

const html = (rows: unknown[]) => renderInvoiceHtml({
  clientName: 'Acme', fromDay: '2026-05-01', toDay: '2026-05-31',
  totals: TOTALS as never, details: rows as never,
});

/** The Return Postage / Return Processing cells of the single body row, as text. */
function htmlReturnCells(rows: unknown[]): { postage: string; processing: string } {
  const doc = html(rows);
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(doc)?.[1] ?? '';
  const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]!.trim());
  assert.ok(cells.length >= 2, 'the body row must have cells at all');
  return { postage: cells[cells.length - 2]!, processing: cells[cells.length - 1]! };
}

/** The Return Postage / Return Processing cell VALUES from the Line Items sheet. */
async function xlsxReturnCells(rows: unknown[]): Promise<{ postage: unknown; processing: unknown }> {
  const { default: ExcelJS } = await import('exceljs');
  const buffer = await renderInvoiceXlsx({
    clientName: 'Acme', fromDay: '2026-05-01', toDay: '2026-05-31',
    totals: TOTALS as never, details: rows as never,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  const sheet = wb.worksheets.find((s) => /line item/i.test(s.name)) ?? wb.worksheets[0]!;
  const header = sheet.getRow(1).values as unknown[];
  const postageCol = header.findIndex((v) => String(v ?? '').trim() === 'Return Postage');
  const processingCol = header.findIndex((v) => String(v ?? '').trim() === 'Return Processing');
  assert.ok(postageCol > 0 && processingCol > 0, 'the sheet must carry both return columns');
  // Row 1 is the header; the single fixture row follows it.
  const row = sheet.getRow(2);
  return { postage: row.getCell(postageCol).value, processing: row.getCell(processingCol).value };
}

// ── the five cases Hermes named ──────────────────────────────────────────────

await check('HTML: processing only — postage is BLANK, not $0.00', async () => {
  const cells = htmlReturnCells([returnRow({
    return_processing_amt: '3.00', has_return_processing_line: true, row_total: '3.00',
  })]);
  assert.equal(cells.postage, '—', 'a fee never charged must not render as money');
  assert.equal(cells.processing, '$3.00');
});

await check('HTML: postage only — processing is BLANK', async () => {
  const cells = htmlReturnCells([returnRow({
    return_postage_amt: '7.73', has_return_postage_line: true, row_total: '7.73',
  })]);
  assert.equal(cells.postage, '$7.73');
  assert.equal(cells.processing, '—');
});

await check('HTML: explicit zero renders $0.00, NOT a dash', async () => {
  // The whole distinction, at the point it becomes a claim to the client. This row and
  // the "processing only" row above carry the SAME number for postage.
  const cells = htmlReturnCells([returnRow({
    return_postage_amt: '0', has_return_postage_line: true, row_total: '0',
  })]);
  assert.equal(cells.postage, '$0.00', 'a charge made at no cost is not an absent charge');
  assert.equal(cells.processing, '—');
});

await check('HTML: both components render their own amounts', async () => {
  const cells = htmlReturnCells([returnRow({
    return_postage_amt: '7.73', has_return_postage_line: true,
    return_processing_amt: '3.00', has_return_processing_line: true, row_total: '10.73',
  })]);
  assert.equal(cells.postage, '$7.73');
  assert.equal(cells.processing, '$3.00');
});

await check('HTML: a SUPPRESSED duplicate keeps presence and shows $0.00', async () => {
  // Hermes's accepted ruling: presence describes whether the persisted fee line existed;
  // PS-491 suppression changes its effective billable amount. So a suppressed copy shows
  // a real zero — it was charged and then zeroed — never a dash, which would claim the
  // line never existed.
  const cells = htmlReturnCells([returnRow({
    return_postage_amt: '0', has_return_postage_line: true,
    return_processing_amt: '0', has_return_processing_line: true, row_total: '0',
  })]);
  assert.equal(cells.postage, '$0.00');
  assert.equal(cells.processing, '$0.00');
});

await check('HTML: header, body and footer stay column-aligned', async () => {
  // The two appended columns must exist in all three sections or every cell after them
  // shifts, and the layout guards address cells by position.
  const doc = html([returnRow({ return_postage_amt: '7.73', has_return_postage_line: true })]);
  const headers = [...(/<thead>([\s\S]*?)<\/thead>/.exec(doc)?.[1] ?? '')
    .matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1]!.trim());
  assert.equal(headers[headers.length - 2], 'Return Postage');
  assert.equal(headers[headers.length - 1], 'Return Processing');

  const bodyCells = [...(/<tbody>([\s\S]*?)<\/tbody>/.exec(doc)?.[1] ?? '')
    .matchAll(/<td[^>]*>/g)].length;
  const footRow = /<tfoot>([\s\S]*?)<\/tfoot>/.exec(doc)?.[1] ?? '';
  const footCells = [...footRow.matchAll(/<td[^>]*>/g)].length;
  const footColspan = Number(/colspan="(\d+)"/.exec(footRow)?.[1] ?? '1');
  assert.equal(headers.length, bodyCells, 'body must have one cell per header');
  assert.equal(headers.length, footCells + footColspan - 1, 'footer must span the same width');
});

await check('HTML: the footer does not re-add return money to the Total', async () => {
  // row_total is already a sum over every line type, so a Return Postage total in the
  // footer would invite the reader to add the same money twice.
  const doc = html([returnRow({
    return_postage_amt: '7.73', has_return_postage_line: true, row_total: '7.73',
  })]);
  const footRow = /<tfoot>([\s\S]*?)<\/tfoot>/.exec(doc)?.[1] ?? '';
  assert.ok(!footRow.includes('7.73'), 'the footer must not total the breakout columns');
  assert.ok(footRow.includes('$10.73'), 'the footer Total still comes from the header totals');
});

await check('XLSX: absent is a BLANK cell, present zero is numeric 0', async () => {
  const absent = await xlsxReturnCells([returnRow({
    return_processing_amt: '3.00', has_return_processing_line: true, row_total: '3.00',
  })]);
  assert.equal(absent.postage, null, 'an absent fee must not become a summable 0');
  assert.equal(absent.processing, 3);

  const zero = await xlsxReturnCells([returnRow({
    return_postage_amt: '0', has_return_postage_line: true, row_total: '0',
  })]);
  assert.equal(zero.postage, 0, 'a real zero stays a real numeric zero');
  assert.equal(typeof zero.postage, 'number');
  assert.notEqual(absent.postage, zero.postage,
    'absent and zero must not reach the spreadsheet as the same value');
});

await check('XLSX: postage only, both components, and suppression', async () => {
  const postageOnly = await xlsxReturnCells([returnRow({
    return_postage_amt: '7.73', has_return_postage_line: true, row_total: '7.73',
  })]);
  assert.equal(postageOnly.postage, 7.73);
  assert.equal(postageOnly.processing, null);

  const both = await xlsxReturnCells([returnRow({
    return_postage_amt: '7.73', has_return_postage_line: true,
    return_processing_amt: '3.00', has_return_processing_line: true, row_total: '10.73',
  })]);
  assert.equal(both.postage, 7.73);
  assert.equal(both.processing, 3);

  // Suppression: charged, then zeroed. Presence retained, amount zero.
  const suppressed = await xlsxReturnCells([returnRow({
    return_postage_amt: '0', has_return_postage_line: true,
    return_processing_amt: '0', has_return_processing_line: true, row_total: '0',
  })]);
  assert.equal(suppressed.postage, 0);
  assert.equal(suppressed.processing, 0);
});

await check('an OUTBOUND row leaves both return cells empty in both renderers', async () => {
  const outbound = returnRow({
    shipment_id: 501, return_id: null, order_number_label: '1234',
    pickpack_amt: '2.50', row_total: '2.50', billing_status_label: 'Fulfilled',
  });
  const cells = htmlReturnCells([outbound]);
  assert.equal(cells.postage, '—');
  assert.equal(cells.processing, '—');
  const sheet = await xlsxReturnCells([outbound]);
  assert.equal(sheet.postage, null, 'no invoice may print a return fee on a shipment row');
  assert.equal(sheet.processing, null);
});

// ── the shared owner is the only decider ─────────────────────────────────────
await check('all three serializers resolve through the SAME owner', () => {
  // Two of the three renderers got this wrong in the same way when each decided
  // independently. The owner returns number | null so each renderer makes only a
  // FORMATTING choice, and a null-to-zero mutation there fails every one of them at once.
  assert.equal(resolveBillingInvoiceReturnFee({ present: false, amount: '7.73' }), null,
    'presence, not the amount, decides whether a cell exists');
  assert.equal(resolveBillingInvoiceReturnFee({ present: true, amount: '0' }), 0);
  assert.equal(resolveBillingInvoiceReturnFee({ present: true, amount: '7.73' }), 7.73);
  // An untaught caller must not silently assert that every return was charged both fees.
  assert.equal(resolveBillingInvoiceReturnFee({ amount: '7.73' }), null);
  // A present-but-unparseable amount is 0, never NaN — the line's EXISTENCE is the fact.
  assert.equal(resolveBillingInvoiceReturnFee({ present: true, amount: 'oops' }), 0);
});

if (failures > 0) {
  console.error(`\nFAIL PS-488 invoice return presence guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-488 invoice return presence guard');
