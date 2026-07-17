import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  previewShipmentCustomerShippingMoney,
  previewShipmentCustomerShippingMoneyWithSelectedRateCost,
  readFrozenCustomerShippingMoney,
} from '../src/services/customer-shipping-money.js';

type AuditRow = {
  returnId: number;
  returnReference: string | null;
  returnStatus: string;
  clientId: number | null;
  clientName: string | null;
  orderId: number | null;
  shipmentId: number | null;
  shipDate: Date | string | null;
  shipmentSource: string | null;
  labelCreatedAt: Date | string | null;
  hasLabelProviderKey: boolean;
  compatibilityRate: string | number | null;
  selectedRateCost: string | number | null;
  cost: string | number | null;
  labelCost: string | number | null;
  otherCost: string | number | null;
  selectedRateJson: unknown;
  purchaseIntentState: string | null;
  purchaseSelectedRateJson: unknown;
  providerReceiptJson: unknown;
};

type BillingAuditRow = {
  id: number;
  clientId: number;
  orderId: number | null;
  shipmentId: number | null;
  lineType: string;
  description: string;
  unitCost: string | number;
  totalCost: string | number;
  invoiced: boolean;
  shipDate: Date | string | null;
  billingEffectiveDate: Date | string | null;
};

type FinalizationAuditRow = {
  id: string;
  clientId: number;
  periodStart: Date | string;
  periodEnd: Date | string;
  finalizedAt: Date | string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nestedAmount(value: unknown): number | null {
  const row = record(value);
  return finite(row?.amount);
}

function selectedRateTotal(value: unknown): number | null {
  const row = record(value);
  if (!row) return null;
  const shipping = nestedAmount(row.shipping_amount);
  if (shipping == null || shipping <= 0) return null;
  return Math.round((
    shipping +
    (nestedAmount(row.confirmation_amount) ?? 0) +
    (nestedAmount(row.other_amount) ?? 0)
  ) * 100) / 100;
}

function providerReceiptCost(value: unknown): number | null {
  const row = record(value);
  const direct = finite(row?.cost);
  if (direct != null && direct > 0) return Math.round(direct * 100) / 100;
  const shipStation = nestedAmount(row?.shipment_cost);
  return shipStation != null && shipStation > 0 ? Math.round(shipStation * 100) / 100 : null;
}

const rows = await db.execute<AuditRow>(sql`
  select r.id as "returnId", r.return_reference as "returnReference",
    r.status as "returnStatus",
    coalesce(s.client_id, r.client_id, o.client_id) as "clientId",
    c.name as "clientName",
    r.order_id as "orderId",
    r.return_shipment_id as "shipmentId",
    s.ship_date as "shipDate",
    s.source as "shipmentSource",
    s.label_created_at as "labelCreatedAt",
    (s.label_provider_key is not null) as "hasLabelProviderKey",
    r.return_customer_shipping_rate as "compatibilityRate",
    s.selected_rate_cost as "selectedRateCost",
    s.cost,
    s.label_cost as "labelCost",
    s.other_cost as "otherCost",
    s.selected_rate_json as "selectedRateJson",
    pi.state as "purchaseIntentState",
    pi.selected_rate_json as "purchaseSelectedRateJson",
    pi.provider_receipt_json as "providerReceiptJson"
  from returns r
  left join shipments s on s.id = r.return_shipment_id
  left join orders o on o.id = r.order_id
  left join clients c on c.id = coalesce(s.client_id, r.client_id, o.client_id)
  left join return_label_purchase_intents pi on pi.return_id = r.id
  order by r.id
  limit 500
`);

const billingRows = await db.execute<BillingAuditRow>(sql`
  select bli.id, bli.client_id as "clientId", bli.order_id as "orderId",
    bli.shipment_id as "shipmentId", bli.line_type as "lineType",
    bli.description, bli.unit_cost as "unitCost", bli.total_cost as "totalCost",
    bli.invoiced, bli.ship_date as "shipDate",
    bli.billing_effective_date as "billingEffectiveDate"
  from billing_line_items bli
  where exists (
    select 1
    from returns r
    where r.return_shipment_id = bli.shipment_id
      or (
        r.order_id = bli.order_id
        and bli.line_type in ('return_postage', 'return_processing_fee')
      )
  )
  order by bli.id
`);

const finalizationRows = await db.execute<FinalizationAuditRow>(sql`
  select distinct bf.id, bf.client_id as "clientId",
    bf.period_start as "periodStart", bf.period_end as "periodEnd",
    bf.finalized_at as "finalizedAt"
  from billing_finalizations bf
  join returns r on true
  left join shipments s on s.id = r.return_shipment_id
  left join orders o on o.id = r.order_id
  where bf.client_id = coalesce(s.client_id, r.client_id, o.client_id)
    and coalesce(s.ship_date, s.label_created_at, s.created_at) >= bf.period_start
    and coalesce(s.ship_date, s.label_created_at, s.created_at) < bf.period_end
  order by bf.period_start, bf.id
`);

const report = [];
for (const row of rows) {
  const frozen = readFrozenCustomerShippingMoney(row.selectedRateJson);
  const current = frozen?.cShippingRateAmount ??
    (row.compatibilityRate == null ? null : Number(row.compatibilityRate));
  const shipmentCost = finite(row.cost) ?? 0;
  const labelCost = finite(row.labelCost) ?? 0;
  const legacyPostage = shipmentCost > 0 ? shipmentCost : labelCost;
  const legacyOther = finite(row.otherCost) ?? 0;
  const legacyCostEvidence = Number.isFinite(legacyPostage + legacyOther)
    ? Math.round((legacyPostage + legacyOther) * 100) / 100
    : null;
  const receiptCost = providerReceiptCost(row.providerReceiptJson);
  const shipmentRateEnvelopeCost = selectedRateTotal(row.selectedRateJson);
  const purchaseRateEnvelopeCost = selectedRateTotal(row.purchaseSelectedRateJson);
  const offlineTestNoCharge = row.shipmentSource === 'test_offline' && legacyCostEvidence === 0;
  const persistedProviderReceipt =
    row.shipmentSource === 'prepship_return_v2' &&
    row.hasLabelProviderKey &&
    row.labelCreatedAt != null &&
    legacyCostEvidence != null &&
    legacyCostEvidence > 0 &&
    Math.abs(shipmentCost - labelCost) < 0.001;
  const exactEvidenceCost = receiptCost ?? (persistedProviderReceipt ? legacyCostEvidence : null);
  let expected: number | null = null;
  let error: string | null = null;
  if (row.shipmentId != null) {
    try {
      const decision = row.selectedRateCost != null
        ? await previewShipmentCustomerShippingMoney(row.shipmentId)
        : exactEvidenceCost != null
          ? await previewShipmentCustomerShippingMoneyWithSelectedRateCost(
            row.shipmentId,
            exactEvidenceCost,
          )
          : null;
      expected = decision?.cShippingRateAmount ?? null;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : 'unavailable';
    }
  }
  const evidenceKind = frozen
    ? 'frozen_policy_tuple'
    : offlineTestNoCharge
      ? 'offline_test_no_charge'
      : receiptCost != null
        ? 'durable_provider_receipt'
        : persistedProviderReceipt
          ? 'persisted_provider_label_receipt'
          : 'insufficient_exact_evidence';
  report.push({
    returnId: row.returnId,
    returnReference: row.returnReference,
    shipmentId: row.shipmentId,
    frozenCustomerRate: frozen?.cShippingRateAmount ?? null,
    selectedRateCost: row.selectedRateCost == null ? null : Number(row.selectedRateCost),
    returnStatus: row.returnStatus,
    clientName: row.clientName,
    shipmentSource: row.shipmentSource,
    legacyCostEvidence,
    providerReceiptCost: receiptCost,
    shipmentRateEnvelopeCost,
    purchaseRateEnvelopeCost,
    evidenceKind,
    repairCandidateSelectedRateCost: exactEvidenceCost,
    compatibilityRate: row.compatibilityRate == null ? null : Number(row.compatibilityRate),
    canonicalExpectedRate: expected,
    delta: current != null && expected != null
      ? Math.round((current - expected) * 100) / 100
      : null,
    provenance: frozen?.customerRateSource ?? null,
    status: frozen
      ? 'frozen'
      : offlineTestNoCharge
        ? 'offline_test_no_charge'
        : exactEvidenceCost != null
          ? 'repair_candidate'
          : 'reconciliation_required',
    error,
  });
}

console.log(JSON.stringify({
  mode: 'read-only',
  count: report.length,
  rows: report,
  billing: billingRows.map((row) => ({
    ...row,
    unitCost: Number(row.unitCost),
    totalCost: Number(row.totalCost),
  })),
  finalizations: finalizationRows,
}, null, 2));
