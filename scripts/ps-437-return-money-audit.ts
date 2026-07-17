import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  previewShipmentCustomerShippingMoney,
  readFrozenCustomerShippingMoney,
} from '../src/services/customer-shipping-money.js';

type AuditRow = {
  returnId: number;
  returnReference: string | null;
  shipmentId: number | null;
  compatibilityRate: string | number | null;
  selectedRateCost: string | number | null;
  cost: string | number | null;
  labelCost: string | number | null;
  otherCost: string | number | null;
  selectedRateJson: unknown;
};

const rows = await db.execute<AuditRow>(sql`
  select r.id as "returnId", r.return_reference as "returnReference",
    r.return_shipment_id as "shipmentId",
    r.return_customer_shipping_rate as "compatibilityRate",
    s.selected_rate_cost as "selectedRateCost",
    s.cost,
    s.label_cost as "labelCost",
    s.other_cost as "otherCost",
    s.selected_rate_json as "selectedRateJson"
  from returns r
  left join shipments s on s.id = r.return_shipment_id
  order by r.id
  limit 500
`);

const report = [];
for (const row of rows) {
  const frozen = readFrozenCustomerShippingMoney(row.selectedRateJson);
  let expected: number | null = null;
  let error: string | null = null;
  if (row.shipmentId != null) {
    try {
      expected = (await previewShipmentCustomerShippingMoney(row.shipmentId)).cShippingRateAmount;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'unavailable';
    }
  }
  const current = frozen?.cShippingRateAmount ??
    (row.compatibilityRate == null ? null : Number(row.compatibilityRate));
  const legacyPostage = Number(row.cost ?? row.labelCost ?? 0);
  const legacyOther = Number(row.otherCost ?? 0);
  report.push({
    returnId: row.returnId,
    returnReference: row.returnReference,
    shipmentId: row.shipmentId,
    frozenCustomerRate: frozen?.cShippingRateAmount ?? null,
    selectedRateCost: row.selectedRateCost == null ? null : Number(row.selectedRateCost),
    legacyCostEvidence: Number.isFinite(legacyPostage + legacyOther)
      ? Math.round((legacyPostage + legacyOther) * 100) / 100
      : null,
    compatibilityRate: row.compatibilityRate == null ? null : Number(row.compatibilityRate),
    canonicalExpectedRate: expected,
    delta: current != null && expected != null
      ? Math.round((current - expected) * 100) / 100
      : null,
    provenance: frozen?.customerRateSource ?? null,
    status: frozen ? 'frozen' : 'reconciliation_required',
    error,
  });
}

console.log(JSON.stringify({ mode: 'read-only', count: report.length, rows: report }, null, 2));
