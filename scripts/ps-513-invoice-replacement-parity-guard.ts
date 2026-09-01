/**
 * PS-513 — replacement charges must render on the CUSTOMER invoice (HTML / XLSX / CSV), not a
 * nonzero Total with every component column blank.
 *
 * Follow-up to PS-512 (which fixed the operator Billing DETAIL). The invoice render family is a
 * SEPARATE read path: billingInvoiceData's row_total already sums replacement money (and the
 * header grandTotal breaks it out, billing-invoice-totals.ts PS-502 AC-18), but no invoice
 * column showed it — the same reconciliation gap the return columns (PS-488 M3) closed.
 *
 * Every check drives the REAL exported renderers (renderInvoiceHtml / renderInvoiceXlsx /
 * renderInvoiceCsvRow) or the shared row-total owner, then reads the produced document. Pure:
 * no DB, no network, no provider calls.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveBillingInvoiceRowTotal } from '../src/services/billing-invoice-row-total';
import { renderInvoiceCsvRow, INVOICE_CSV_HEADERS } from '../src/routes/billing-invoice-csv';

// billing.ts validates env at import time; obviously-fake values let us import the pure
// renderers without live config (same convention as ps-488-invoice-return-presence-guard).
const INERT_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://ps513:ps513@127.0.0.1:1/ps513_unused',
  SUPABASE_URL: 'https://ps513-test.supabase.invalid',
  SUPABASE_ANON_KEY: 'ps513-test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'ps513-test-service-role-key',
  SUPABASE_JWT_SECRET: 'ps513-test-jwt-secret-not-real',
};
for (const [key, value] of Object.entries(INERT_ENV)) process.env[key] = value;

const { renderInvoiceHtml, renderInvoiceXlsx } = await import('../src/routes/billing');

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

const TOTALS = {
  orderCount: 1, replacementCount: 1, pickPackTotal: 0, additionalTotal: 0, pickPackFeeTotal: 0,
  packageTotal: 0, shippingTotal: 0, storageTotal: 0, adjustmentTotal: 0,
  replacePostageTotal: 8.75, replacePickPackTotal: 3, grandTotal: 11.75, fulfillmentFeeTotal: 0,
};

/** A replacement row in the shape billingInvoiceData hands the renderers: replacement money
 *  only, folded onto the outbound order row (no return_id). */
function replacementRow(over: Record<string, unknown> = {}) {
  return {
    order_id: 5252, order_number: '2200', shipment_id: 52521, return_id: null,
    ship_date: '2026-05-07', billing_effective_date: '2026-05-07',
    billing_policy_version: null, billing_adjustment_id: null,
    source_finalization_id: null, adjustment_description: null,
    base_qty: '0', addl_qty: '0', pickpack_amt: '0', additional_amt: '0',
    shipping_amt: '0', storage_amt: '0', package_cost_amt: '0',
    return_postage_amt: '0', return_processing_amt: '0',
    has_return_postage_line: false, has_return_processing_line: false,
    replace_postage_amt: '8.75', replace_pick_pack_amt: '3.00',
    row_total: '11.75', item_names: null, skus: null,
    carrier_code: null, box_label: '—', box_review: false, fee_waived: false,
    destination: 'Domestic', order_number_label: '2200',
    ...over,
  } as never;
}

const html = (rows: unknown[]) => renderInvoiceHtml({
  clientName: 'Acme', fromDay: '2026-05-01', toDay: '2026-05-31',
  totals: TOTALS as never, details: rows as never,
});

function htmlCellsByHeader(rows: unknown[]): { headers: string[]; cells: string[] } {
  const doc = html(rows);
  const headers = [...(/<thead>([\s\S]*?)<\/thead>/.exec(doc)?.[1] ?? '')
    .matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1]!.trim());
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(doc)?.[1] ?? '';
  const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]!.trim());
  return { headers, cells };
}

// ── HTML ─────────────────────────────────────────────────────────────────────
await check('HTML: a replacement row shows its money in the Replace columns, not $0.00', () => {
  const { headers, cells } = htmlCellsByHeader([replacementRow()]);
  const postageCol = headers.indexOf('Replace Postage');
  const pickPackCol = headers.indexOf('Replace Pick&amp;Pack');
  assert.ok(postageCol >= 0 && pickPackCol >= 0, 'the invoice must carry both Replace columns');
  assert.equal(cells[postageCol], '$8.75', 'Replace Postage must render the charge, not $0.00 or a dash');
  assert.equal(cells[pickPackCol], '$3.00', 'Replace Pick&Pack must render the charge');
  // The Total column still carries row_total (the money was never lost, only unshown before).
  const totalCol = headers.indexOf('Total');
  assert.equal(cells[totalCol], '$11.75', 'the Total column stays the backend row_total');
});

await check('HTML: a NON-replacement row leaves both Replace columns as a dash', () => {
  const { headers, cells } = htmlCellsByHeader([replacementRow({
    replace_postage_amt: '0', replace_pick_pack_amt: '0', row_total: '4.50',
    pickpack_amt: '4.50',
  })]);
  assert.equal(cells[headers.indexOf('Replace Postage')], '—', 'no replacement -> dash, not $0.00');
  assert.equal(cells[headers.indexOf('Replace Pick&amp;Pack')], '—');
});

await check('HTML: replacement money never leaks into the outbound money columns', () => {
  const { headers, cells } = htmlCellsByHeader([replacementRow()]);
  // Shipping is the outbound money column a re-ship's postage would most plausibly leak into;
  // it stays a dash because the row has no shipping line. The full no-leak property is proven
  // by the CSV reconciliation below (components incl. replace sum exactly to Total).
  assert.equal(cells[headers.indexOf('Shipping')], '—', 'replacement postage must not appear as Shipping');
  // Every visible outbound money cell before Total is a dash on a replacement-only row.
  const totalCol = headers.indexOf('Total');
  const boxCol = headers.indexOf('Box Cost');
  assert.ok(boxCol >= 0 && cells[boxCol] === '—', 'replacement money must not appear as Box Cost');
  assert.equal(cells[totalCol], '$11.75', 'only the Total (and the Replace columns) carry the money');
});

// ── XLSX ─────────────────────────────────────────────────────────────────────
await check('XLSX: the Replace columns carry the numbers; a non-replacement row is blank', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const load = async (rows: unknown[]) => {
    const buffer = await renderInvoiceXlsx({
      clientName: 'Acme', fromDay: '2026-05-01', toDay: '2026-05-31',
      totals: TOTALS as never, details: rows as never,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const sheet = wb.worksheets[0]!;
    const header = sheet.getRow(1).values as unknown[];
    const col = (name: string) => header.findIndex((v) => String(v ?? '').trim() === name);
    const postageCol = col('Replace Postage');
    const pickPackCol = col('Replace Pick&Pack');
    assert.ok(postageCol > 0 && pickPackCol > 0, 'the sheet must carry both Replace columns');
    const row = sheet.getRow(2);
    return { postage: row.getCell(postageCol).value, pickPack: row.getCell(pickPackCol).value };
  };
  const charged = await load([replacementRow()]);
  assert.equal(charged.postage, 8.75, 'Replace Postage must be a real number in the sheet');
  assert.equal(charged.pickPack, 3);
  const none = await load([replacementRow({ replace_postage_amt: '0', replace_pick_pack_amt: '0', row_total: '4.50', pickpack_amt: '4.50' })]);
  assert.equal(none.postage, null, 'a non-replacement row must be blank, not a summable 0');
  assert.equal(none.pickPack, null);
});

// ── CSV ──────────────────────────────────────────────────────────────────────
await check('CSV: a replacement row reconciles against its own component columns', () => {
  const cells = renderInvoiceCsvRow(replacementRow()).split(',');
  const at = (h: string) => Number(cells[INVOICE_CSV_HEADERS.indexOf(h as never)]);
  assert.equal(cells[INVOICE_CSV_HEADERS.indexOf('Replace Postage' as never)], '8.75');
  assert.equal(cells[INVOICE_CSV_HEADERS.indexOf('Replace Pick&Pack' as never)], '3');
  assert.equal(cells[INVOICE_CSV_HEADERS.indexOf('Total' as never)], '11.75');
  assert.equal(
    at('Box Cost') + at('Pick & Pack Fee') + at('Shipping') + at('Storage')
      + at('Return Postage') + at('Return Processing') + at('Replace Postage') + at('Replace Pick&Pack'),
    at('Total'),
    'CSV replacement row must reconcile to its Total',
  );
});

// ── shared row-total owner ───────────────────────────────────────────────────
await check('resolveBillingInvoiceRowTotal counts replacement money once in the zero-total fallback', () => {
  // Nonzero row_total is authoritative and returns immediately.
  assert.equal(resolveBillingInvoiceRowTotal({
    rowTotal: '11.75', pickPackFee: 0, packageCost: 0, shipping: 0, storage: 0,
    replacePostage: '8.75', replacePickPack: '3.00',
  }), 11.75);
  // A zero-total replacement row reconstructs from the replace terms (the return-parity fix).
  assert.equal(resolveBillingInvoiceRowTotal({
    rowTotal: '0', pickPackFee: 0, packageCost: 0, shipping: 0, storage: 0,
    replacePostage: '8.75', replacePickPack: '3.00',
  }), 11.75);
});

// ── source pins: the SQL buckets exist so the detail rows carry the money ─────
await check('billingInvoiceData SQL buckets replace_postage / replace_pick_pack', () => {
  const src = readFileSync('src/routes/billing.ts', 'utf8');
  assert.ok(/replace_postage'\s+then \$\{detailAmount\}[^]*?as replace_postage_amt/.test(src)
    || src.includes("case when b.line_type = 'replace_postage' then ${detailAmount} else 0 end), 0)::text as replace_postage_amt"),
    'the invoice SQL must sum replace_postage into replace_postage_amt');
  assert.ok(src.includes("as replace_pick_pack_amt"), 'the invoice SQL must sum replace_pick_pack_amt');
});

if (failures > 0) {
  console.error(`\nFAIL PS-513 invoice replacement parity guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-513 invoice replacement parity guard');
