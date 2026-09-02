/**
 * PS-425 offline integration proof.
 *
 * In-memory PGlite only: no production database, provider, label, postage, or
 * marketplace side effect is reachable from this fixture.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { invoiceColumnIndex } from '../src/routes/billing-invoice-columns';
import { drizzle } from 'drizzle-orm/pglite';

async function main(): Promise<void> {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.NODE_ENV = 'test';

  const {
    activeOutboundShipmentPredicate,
    decideShipmentVoidLifecycle,
    withShipmentBillingLineage,
  } = await import('../src/services/shipment-aggregate.js');
  const { shipments } = await import('../src/db/schema/shipments.js');
  const {
    buildShippingMarginAnalytics,
    buildShippingMarginRow,
  } = await import('../src/services/shipping-margin-analytics.js');
  const { renderInvoiceCsv } = await import('../src/routes/billing-invoice-csv.js');
  const { renderInvoiceHtml, renderInvoiceXlsx } = await import('../src/routes/billing.js');
  const { default: ExcelJS } = await import('exceljs');

  const client = new PGlite();
  await client.exec(`
    CREATE TABLE shipments (
      id integer PRIMARY KEY,
      order_id integer,
      label_shipment_id integer,
      voided boolean NOT NULL DEFAULT false,
      is_return boolean NOT NULL DEFAULT false,
      selected_rate_cost numeric(10,2)
    );
    CREATE UNIQUE INDEX shipments_label_shipment_id_unique_idx
      ON shipments (label_shipment_id)
      WHERE label_shipment_id IS NOT NULL;
    INSERT INTO shipments
      (id, order_id, label_shipment_id, voided, is_return, selected_rate_cost)
    VALUES
      (501, 425, 9501, false, false, 10.00),
      (502, 425, 9502, false, false, 15.00),
      (503, 425, 9503, false, true, 4.00),
      (504, 425, 9504, true, false, 9.00);

    CREATE TABLE billing_line_items (
      id serial PRIMARY KEY,
      client_id integer NOT NULL,
      order_id integer,
      order_number text,
      shipment_id integer,
      ship_date timestamptz,
      line_type text NOT NULL,
      description text NOT NULL,
      qty numeric(10,2) NOT NULL DEFAULT 1,
      unit_cost numeric(10,2) NOT NULL,
      total_cost numeric(10,2) NOT NULL,
      CONSTRAINT billing_li_unique UNIQUE (order_id, line_type, description)
    );
  `);
  await client.exec(readFileSync('drizzle/0068_billing_shipment_cardinality.sql', 'utf8'));

  const pg = drizzle(client, { casing: 'snake_case' });
  const activeBefore = await pg
    .select({ id: shipments.id })
    .from(shipments)
    .where(activeOutboundShipmentPredicate({ orderId: 425 }));
  assert.deepEqual(activeBefore.map((row) => row.id).sort(), [501, 502],
    'returns and voided/replaced labels are excluded from the active outbound aggregate');
  await assert.rejects(
    client.exec(`INSERT INTO shipments (id, order_id, label_shipment_id) VALUES (505, 425, 9502)`),
    /unique|duplicate/i,
    'provider duplicates are rejected by the shipment identity constraint',
  );

  const shippingDescription = 'Shipping · order PS-425';
  const description501 = withShipmentBillingLineage(shippingDescription, 501);
  const description502 = withShipmentBillingLineage(shippingDescription, 502);
  const inserted = await client.query<{ id: number; shipment_id: number; total_cost: string }>(`
    INSERT INTO billing_line_items
      (client_id, order_id, order_number, shipment_id, ship_date, line_type, description, qty, unit_cost, total_cost)
    VALUES
      (42, 425, 'PS-425', 501, '2026-07-15T00:00:00Z', 'shipping', '${description501}', 1, 12.00, 12.00),
      (42, 425, 'PS-425', 502, '2026-07-15T00:00:00Z', 'shipping', '${description502}', 1, 20.00, 20.00)
    RETURNING id, shipment_id, total_cost::text
  `);
  assert.equal(inserted.rows.length, 2, 'RETURNING reports both persisted shipment lines');
  assert.equal(
    inserted.rows.reduce((sum, row) => sum + Number(row.total_cost), 0),
    32,
    'returned total equals the two persisted customer charges',
  );
  const persisted = await client.query<{ count: number; total: string }>(`
    SELECT count(*)::int AS count, sum(total_cost)::text AS total
    FROM billing_line_items WHERE order_id = 425
  `);
  assert.deepEqual(persisted.rows[0], { count: 2, total: '32.00' });
  await assert.rejects(
    client.exec(`
      INSERT INTO billing_line_items
        (client_id, order_id, shipment_id, line_type, description, unit_cost, total_cost)
      VALUES (42, 425, 501, 'shipping', '${description501}', 12.00, 12.00)
    `),
    /unique|duplicate/i,
    'a duplicate candidate fails loudly instead of conflict-dropping',
  );
  const persistedAfterRepeat = await client.query<{ count: number; total: string }>(`
    SELECT count(*)::int AS count, sum(total_cost)::text AS total
    FROM billing_line_items WHERE order_id = 425
  `);
  assert.deepEqual(
    persistedAfterRepeat.rows[0],
    { count: 2, total: '32.00' },
    'a rejected repeat run leaves cardinality and total unchanged',
  );

  const marginRows = [
    buildShippingMarginRow({
      clientId: 42,
      clientName: 'Fixture',
      shipmentId: 501,
      orderId: 425,
      orderNumber: 'PS-425',
      shipDate: '2026-07-15T00:00:00Z',
      shipmentCost: null,
      shipmentLabelCost: null,
      shipmentOtherCost: '0',
      selectedRateCost: '10.00',
      billingLineItemId: inserted.rows[0]!.id,
      billingTotalCost: '12.00',
      projectedBillableAmount: null,
      projectedBillableSource: null,
      cShippingRateAmount: null,
      carrierCode: 'ups',
      serviceCode: 'ground',
      providerAccountId: 1,
      providerAccountNickname: 'UPS Main',
    }),
    buildShippingMarginRow({
      clientId: 42,
      clientName: 'Fixture',
      shipmentId: 502,
      orderId: 425,
      orderNumber: 'PS-425',
      shipDate: '2026-07-15T00:00:00Z',
      shipmentCost: null,
      shipmentLabelCost: null,
      shipmentOtherCost: '0',
      selectedRateCost: '15.00',
      billingLineItemId: inserted.rows[1]!.id,
      billingTotalCost: '20.00',
      projectedBillableAmount: null,
      projectedBillableSource: null,
      cShippingRateAmount: null,
      carrierCode: 'usps',
      serviceCode: 'priority',
      providerAccountId: 2,
      providerAccountNickname: 'USPS Main',
    }),
  ];
  const margin = buildShippingMarginAnalytics(marginRows, {
    dateFrom: '2026-07-01T00:00:00Z',
    dateTo: '2026-08-01T00:00:00Z',
  });
  assert.equal(margin.summary.actualShippingTotal, 25);
  assert.equal(margin.summary.billableShippingTotal, 32);
  assert.equal(margin.summary.marginTotal, 7);
  assert.deepEqual(margin.rows.map((row) => row.shipmentId), [501, 502]);

  const details = [501, 502].map((shipmentId, index) => ({
    order_id: 425,
    order_number: 'PS-425',
    shipment_id: shipmentId,
    ship_date: '2026-07-15',
    base_qty: '1',
    addl_qty: '0',
    pickpack_amt: '0',
    additional_amt: '0',
    shipping_amt: index === 0 ? '12.00' : '20.00',
    storage_amt: '0',
    row_total: index === 0 ? '12.00' : '20.00',
    billing_status_label: 'Fulfilled',
    item_names: 'Fixture item',
    skus: 'FIXTURE-1',
    carrier_code: index === 0 ? 'ups' : 'usps',
    package_cost_amt: '0',
    box_label: '—',
    box_review: false,
    fee_waived: false,
  }));
  const totals = {
    orderCount: 1,
    pickPackTotal: 0,
    additionalTotal: 0,
    pickPackFeeTotal: 0,
    packageTotal: 0,
    shippingTotal: 32,
    storageTotal: 0,
    grandTotal: 32,
    fulfillmentFeeTotal: 32,
  };
  const csv = renderInvoiceCsv(details);
  // PS-488 M3: the end-of-line anchor is gone. PS-490 appended Destination and kept the
  // `\r?\n` here, which only passed because that column was BOTH empty AND last — the row
  // happened to end with the comma before the newline. Appending Return Postage and Return
  // Processing broke it again, and that is the tell: the anchor was pinning "Shipment # is
  // the final column", not the shipment cardinality this guard exists to prove.
  //
  // Now matched the same way #502 already was on the next line — the four cells in
  // sequence, wherever the row happens to end. Appending a column can no longer break a
  // shipment-grain assertion.
  assert.match(csv, /,12,0,12,#501,/);
  assert.match(csv, /,20,0,20,#502,/);
  const html = renderInvoiceHtml({
    clientName: 'Fixture',
    fromDay: '2026-07-01',
    toDay: '2026-07-31',
    totals,
    details,
  });
  assert.match(html, />#501<\/td>/);
  assert.match(html, />#502<\/td>/);
  const xlsx = await renderInvoiceXlsx({
    clientName: 'Fixture',
    fromDay: '2026-07-01',
    toDay: '2026-07-31',
    totals,
    details,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx);
  const sheet = workbook.getWorksheet('Invoice');
  // Column NUMBERS are derived, not typed. These were hard-coded (14 and 11) and PS-505 had
  // already been forced to renumber them once when a column was removed; unifying the three
  // exports onto one column contract moved them again. A typed number here does not fail
  // loudly when the layout shifts — it reads the neighbouring column and asserts against the
  // wrong cell, which is the same trap the XLSX totals row's SUM letters had.
  const shipmentCell = invoiceColumnIndex('shipmentId') + 1;
  const shippingCell = invoiceColumnIndex('shipping') + 1;
  assert.equal(sheet?.getRow(2).getCell(shipmentCell).value, '#501');
  assert.equal(sheet?.getRow(3).getCell(shipmentCell).value, '#502');
  assert.equal(sheet?.getRow(2).getCell(shippingCell).value, 12);
  assert.equal(sheet?.getRow(3).getCell(shippingCell).value, 20);

  await client.exec(`UPDATE shipments SET voided = true WHERE id = 501`);
  const afterFirstVoid = await pg
    .select({ id: shipments.id })
    .from(shipments)
    .where(activeOutboundShipmentPredicate({ orderId: 425 }));
  assert.deepEqual(afterFirstVoid.map((row) => row.id), [502]);
  assert.equal(decideShipmentVoidLifecycle({
    remainingActiveOutboundShipmentCount: afterFirstVoid.length,
    orderStatus: 'shipped',
  }).kind, 'keep_shipped');

  await client.exec(`UPDATE shipments SET voided = true WHERE id = 502`);
  const afterFinalVoid = await pg
    .select({ id: shipments.id })
    .from(shipments)
    .where(activeOutboundShipmentPredicate({ orderId: 425 }));
  assert.equal(afterFinalVoid.length, 0);
  assert.equal(decideShipmentVoidLifecycle({
    remainingActiveOutboundShipmentCount: 0,
    orderStatus: 'shipped',
  }).kind, 'reopen');
  assert.equal(decideShipmentVoidLifecycle({
    remainingActiveOutboundShipmentCount: 0,
    orderStatus: 'shipped',
    canonicalStatus: 'shipped',
  }).kind, 'preserve_terminal');
  assert.equal(decideShipmentVoidLifecycle({
    remainingActiveOutboundShipmentCount: 0,
    orderStatus: 'shipped',
    externallyShipped: true,
  }).kind, 'preserve_terminal');

  await client.exec(readFileSync(
    'docs/final-review/evidence/PS-425-migration-rollback.sql',
    'utf8',
  ));
  const afterRollback = await client.query<{ count: number; total: string }>(`
    SELECT count(*)::int AS count, sum(total_cost)::text AS total
    FROM billing_line_items WHERE order_id = 425
  `);
  assert.deepEqual(
    afterRollback.rows[0],
    { count: 2, total: '32.00' },
    'rollback restores the legacy key without rewriting current shipment lines',
  );
  await client.exec(`
    INSERT INTO billing_line_items
      (client_id, order_id, order_number, line_type, description, qty, unit_cost, total_cost)
    VALUES
      (42, 426, 'PS-425-LEGACY', 'shipping', 'Legacy shipping row', 1, 9.00, 9.00)
  `);
  await assert.rejects(
    client.exec(`
      INSERT INTO billing_line_items
        (client_id, order_id, order_number, line_type, description, qty, unit_cost, total_cost)
      VALUES
        (42, 426, 'PS-425-LEGACY', 'shipping', 'Legacy shipping row', 1, 9.00, 9.00)
    `),
    /unique|duplicate/i,
    'rollback restores the previous application duplicate constraint',
  );

  await client.close();
  console.log('PASS PS-425 multi-shipment cardinality/lifecycle integration');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
