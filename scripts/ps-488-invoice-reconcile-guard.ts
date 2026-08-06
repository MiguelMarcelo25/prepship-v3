/**
 * PS-488 AC-6 guard — the invoice reconciliation projection (Handoff v1.1).
 *
 * Offline/pure: no DB, no network, no provider calls, no billing regeneration.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcileInvoiceRows } from '../src/routes/billing-invoice-reconcile';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

// Two shipments of ONE order — the case a direct DTO swap would have collapsed.
const OUTBOUND = [
  { orderId: 4242, orderNumber: '1234', shipmentId: 501, shippingTotal: 5, grandTotal: 5 },
  { orderId: 4242, orderNumber: '1234', shipmentId: 502, shippingTotal: 7, grandTotal: 7 },
];

const CANONICAL = toBillingDetailOrderRows([
  { lineType: 'pick_pack', orderId: 4242, orderNumber: '1234', clientId: 1, qty: 1, totalCost: '2.50', destinationCountry: 'CA' },
  { lineType: 'return_postage', orderId: 4242, orderNumber: '1234', clientId: 1, qty: 1, totalCost: '7.73', returnId: 7, returnReference: '1234-RETURN' },
  { lineType: 'return_processing_fee', orderId: 4242, orderNumber: '1234', clientId: 1, qty: 1, totalCost: '3.00', returnId: 7, returnReference: '1234-RETURN' },
]);

check('two shipments of one order stay TWO rows, in order', () => {
  // The exact collapse Handoff v1's direct cutover would have caused: the DTO keys
  // outbound rows order:<orderId>, the invoice keeps one row per frozen shipment.
  const rows = reconcileInvoiceRows({ outbound: OUTBOUND, canonical: CANONICAL });
  const outbound = rows.filter((r) => r.rowType === 'Outbound');
  assert.equal(outbound.length, 2, 'shipment grain must survive reconciliation');
  assert.equal(outbound[0]!.shipmentId, 501);
  assert.equal(outbound[1]!.shipmentId, 502);
});

check('outbound money is untouched by the stamp', () => {
  const rows = reconcileInvoiceRows({ outbound: OUTBOUND, canonical: CANONICAL });
  const [a, b] = rows.filter((r) => r.rowType === 'Outbound');
  assert.equal(a!.grandTotal, 5, 'frozen outbound total must not move');
  assert.equal(b!.grandTotal, 7);
  assert.equal(a!.shippingTotal, 5);
});

check('return money NEVER lands on an outbound row', () => {
  // The whole point of the many-to-one join being safe: no money crosses it.
  const rows = reconcileInvoiceRows({ outbound: OUTBOUND, canonical: CANONICAL });
  for (const row of rows.filter((r) => r.rowType === 'Outbound')) {
    assert.equal(row.returnPostage, 0, 'outbound rows carry no return postage');
    assert.equal(row.returnProcessing, 0, 'outbound rows carry no return processing');
  }
});

check('return money appears EXACTLY ONCE across the whole invoice', () => {
  // The per-row check above is not sufficient on its own: it passed while a mutation
  // duplicated return money onto outbound rows, because on this fixture the canonical
  // OUTBOUND row's own return totals are already 0 — so the wrong source still read 0.
  // Summing across every row is what actually pins "once, and only on the return row".
  //
  // Two shipments share this order, so a per-order stamp that carried money would bill
  // 7.73 three times: once per shipment plus the return.
  const rows = reconcileInvoiceRows({ outbound: OUTBOUND, canonical: CANONICAL });
  const postage = rows.reduce((sum, r) => sum + Number(r.returnPostage ?? 0), 0);
  const processing = rows.reduce((sum, r) => sum + Number(r.returnProcessing ?? 0), 0);
  assert.equal(postage, 7.73, 'return postage must total 7.73 across the invoice, not a multiple');
  assert.equal(processing, 3, 'return processing must total 3.00 across the invoice');

  const carriers = rows.filter((r) => Number(r.returnPostage ?? 0) !== 0);
  assert.equal(carriers.length, 1, 'exactly one row may carry return postage');
  assert.equal(carriers[0]!.rowType, 'Return', 'and it must be the return row');
});

check('the canonical classification is stamped onto every outbound shipment', () => {
  // AC-3 shape: an international ORDER stays International on all of its rows.
  const rows = reconcileInvoiceRows({ outbound: OUTBOUND, canonical: CANONICAL });
  for (const row of rows.filter((r) => r.rowType === 'Outbound')) {
    assert.equal(row.destination, 'International');
    assert.equal(row.displayReference, '#1234');
  }
});

check('return rows are APPENDED after all outbound rows, never interleaved', () => {
  const rows = reconcileInvoiceRows({ outbound: OUTBOUND, canonical: CANONICAL });
  const lastOutbound = rows.map((r) => r.rowType).lastIndexOf('Outbound');
  const firstReturn = rows.map((r) => r.rowType).indexOf('Return');
  assert.ok(firstReturn > lastOutbound,
    'a return row before the last outbound row would displace a frozen invoice row');
});

check('the return row carries its own money and its persisted reference', () => {
  const rows = reconcileInvoiceRows({ outbound: OUTBOUND, canonical: CANONICAL });
  const ret = rows.find((r) => r.rowType === 'Return')!;
  assert.equal(ret.displayReference, '#1234-RETURN');
  assert.equal(ret.returnPostage, 7.73);
  assert.equal(ret.returnProcessing, 3);
  assert.equal(ret.grandTotal, 10.73, '7.73 postage + 3.00 processing');
});

check('a return inherits the OUTBOUND order classification (AC-3)', () => {
  // The return physically ships to the US warehouse; it must still read International
  // because the ORDER was international. Classification follows the order, not the parcel.
  const rows = reconcileInvoiceRows({ outbound: OUTBOUND, canonical: CANONICAL });
  assert.equal(rows.find((r) => r.rowType === 'Return')!.destination, 'International');
});

check('append order is deterministic and total', () => {
  const canonical = toBillingDetailOrderRows([
    { lineType: 'return_postage', orderId: 4242, orderNumber: '1234', clientId: 1, qty: 1, totalCost: '1.00', returnId: 9, returnReference: '1234-RETURN-2' },
    { lineType: 'return_postage', orderId: 4242, orderNumber: '1234', clientId: 1, qty: 1, totalCost: '2.00', returnId: 7, returnReference: '1234-RETURN' },
  ]);
  const once = reconcileInvoiceRows({ outbound: OUTBOUND, canonical });
  const twice = reconcileInvoiceRows({ outbound: OUTBOUND, canonical: [...canonical].reverse() });
  assert.deepEqual(
    once.map((r) => r.displayReference),
    twice.map((r) => r.displayReference),
    'input order must not change invoice output — returnId breaks every tie',
  );
});

check('no outbound rows means no invented rows', () => {
  const rows = reconcileInvoiceRows({ outbound: [], canonical: CANONICAL });
  assert.equal(rows.filter((r) => r.rowType === 'Outbound').length, 0);
  assert.equal(rows.filter((r) => r.rowType === 'Return').length, 1);
});

check('the reconciler performs no I/O', () => {
  // AC-6's one-read rule lives here: this module must never fetch. Both inputs come from
  // the single billing_line_items read upstream.
  const src = readFileSync('src/routes/billing-invoice-reconcile.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['db.select', 'billingDetails(', 'await ', 'sql`', 'fetch(']) {
    assert.ok(!src.includes(forbidden), `the reconciler must not contain ${forbidden}`);
  }
});

if (failures > 0) {
  console.error(`\nFAIL PS-488 invoice reconcile guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-488 invoice reconcile guard');
