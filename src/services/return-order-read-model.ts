import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { readFrozenCustomerShippingMoney } from './customer-shipping-money-snapshot.js';

export type ReturnOrderItemSummary = {
  sku: string | null;
  name: string;
  quantity: number;
};

export type ReturnOrderShipmentSummary = {
  shipmentId: number;
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  shipDate: string | null;
  labelCreatedAt: string | null;
  labelUrl: string | null;
  labelShipmentId: number | null;
  providerAccountId: string | null;
  providerAccountNickname: string | null;
  weightOz: number | null;
  dimsL: number | null;
  dimsW: number | null;
  dimsH: number | null;
  voided: boolean;
};

export type ReturnOrderSummary = {
  returnId: number;
  returnReference: string | null;
  status: string;
  createdAt: string | null;
  returnCustomerShippingRate: number | null;
  money: {
    baseAmount: number;
    markedAmount: number;
    markupAmount: number;
    insuranceAddOn: null;
    marginPercent: number | null;
    cShippingRateAmount: number;
    selectedRateCost: number;
    shippingMarginAmount: number;
    shippingMarginPct: number | null;
    customerRateSource: string;
    source: 'selected_rate';
    markupSource: 'carrier_markup' | 'house_account';
  } | null;
  items: ReturnOrderItemSummary[];
  shipment: ReturnOrderShipmentSummary | null;
};

type ReturnOrderSummaryRow = {
  orderId: number;
  returnId: number;
  returnReference: string | null;
  status: string;
  createdAt: Date | string | null;
  returnCustomerShippingRate: string | number | null;
  selectedRateJson: unknown;
  items: unknown;
  shipment: unknown;
};

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function normalizeItems(value: unknown): ReturnOrderItemSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = recordOrNull(candidate);
    if (!item) return [];
    const quantity = finiteNumberOrNull(item.quantity);
    return [{
      sku: stringOrNull(item.sku),
      name: stringOrNull(item.name) ?? 'Returned item',
      quantity: quantity != null && quantity > 0 ? Math.trunc(quantity) : 1,
    }];
  });
}

function normalizeShipment(value: unknown): ReturnOrderShipmentSummary | null {
  const shipment = recordOrNull(value);
  const shipmentId = finiteNumberOrNull(shipment?.shipmentId);
  if (!shipment || shipmentId == null) return null;
  return {
    shipmentId,
    trackingNumber: stringOrNull(shipment.trackingNumber),
    carrierCode: stringOrNull(shipment.carrierCode),
    serviceCode: stringOrNull(shipment.serviceCode),
    shipDate: isoOrNull(shipment.shipDate),
    labelCreatedAt: isoOrNull(shipment.labelCreatedAt),
    labelUrl: stringOrNull(shipment.labelUrl),
    labelShipmentId: finiteNumberOrNull(shipment.labelShipmentId),
    providerAccountId: stringOrNull(shipment.providerAccountId),
    providerAccountNickname: stringOrNull(shipment.providerAccountNickname),
    weightOz: finiteNumberOrNull(shipment.weightOz),
    dimsL: finiteNumberOrNull(shipment.dimsL),
    dimsW: finiteNumberOrNull(shipment.dimsW),
    dimsH: finiteNumberOrNull(shipment.dimsH),
    voided: shipment.voided === true,
  };
}

/**
 * Page-bounded, read-only projection of every canonical return workflow.
 * Rate ranking and customer pricing stay in the return-label backend; this
 * reader only exposes frozen facts shared with Client Portal and billing.
 */
export async function loadReturnOrderSummaries(
  orderIds: readonly number[],
): Promise<Map<number, ReturnOrderSummary[]>> {
  const uniqueOrderIds = [...new Set(orderIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, ReturnOrderSummary[]>();
  if (uniqueOrderIds.length === 0) return out;

  // Per user override `unlock shipped data` on 2026-07-16: this is a read-only
  // projection of canonical return, return-item, and return-shipment rows. It
  // never inserts or mutates shipped orders, shipments, labels, or postage.
  const rows = await db.execute<ReturnOrderSummaryRow>(sql`
    select
      r.order_id as "orderId",
      r.id as "returnId",
      r.return_reference as "returnReference",
      r.status,
      r.created_at as "createdAt",
      r.return_customer_shipping_rate as "returnCustomerShippingRate",
      s.selected_rate_json as "selectedRateJson",
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'sku', ri.sku,
            'name', ri.name,
            'quantity', ri.quantity
          ) order by ri.id
        )
        from return_items ri
        where ri.return_id = r.id
      ), '[]'::jsonb) as items,
      case
        when s.id is null or coalesce(s.is_return, false) = false then null
        else jsonb_build_object(
          'shipmentId', s.id,
          'trackingNumber', s.tracking_number,
          'carrierCode', s.carrier_code,
          'serviceCode', s.service_code,
          'shipDate', s.ship_date,
          'labelCreatedAt', s.label_created_at,
          'labelUrl', s.label_url,
          'labelShipmentId', s.label_shipment_id,
          'providerAccountId', s.provider_account_id,
          'providerAccountNickname', s.provider_account_nickname,
          'weightOz', s.weight_oz,
          'dimsL', s.dims_l,
          'dimsW', s.dims_w,
          'dimsH', s.dims_h,
          'voided', coalesce(s.voided, false)
        )
      end as shipment
    from returns r
    left join shipments s on s.id = r.return_shipment_id
    where r.order_id in (${sql.join(uniqueOrderIds.map((id) => sql`${id}`), sql`, `)})
    order by r.order_id, r.created_at asc, r.id asc
  `);

  for (const row of rows) {
    const rate = finiteNumberOrNull(row.returnCustomerShippingRate);
    const frozenMoney = readFrozenCustomerShippingMoney(row.selectedRateJson);
    const money = frozenMoney
      ? {
          baseAmount: frozenMoney.selectedRateCost,
          markedAmount: frozenMoney.cShippingRateAmount,
          markupAmount: frozenMoney.shippingMarginAmount,
          insuranceAddOn: null,
          marginPercent: Math.abs(frozenMoney.shippingMarginAmount) >= 0.005 && frozenMoney.selectedRateCost > 0
            ? Math.round((frozenMoney.shippingMarginAmount / frozenMoney.selectedRateCost) * 100)
            : null,
          cShippingRateAmount: frozenMoney.cShippingRateAmount,
          selectedRateCost: frozenMoney.selectedRateCost,
          shippingMarginAmount: frozenMoney.shippingMarginAmount,
          shippingMarginPct: frozenMoney.shippingMarginPct,
          customerRateSource: frozenMoney.customerRateSource,
          source: 'selected_rate' as const,
          // PS-508: BOTH house provenances map to house_account. This branch is binary and its
          // fallback is 'carrier_markup', so a provenance it does not name is not merely unhandled
          // — it is actively MISLABELLED as carrier markup. `house_next_best_customer_rate` cannot
          // reach here today (this reader accepts ps-437-v1 only, and no v1 writer emits it), but
          // the entire point of the two-version staging is that someone widens this later.
          markupSource: frozenMoney.customerRateSource === 'hugrab_shipping_rate_override'
            || frozenMoney.customerRateSource === 'house_next_best_customer_rate'
            ? 'house_account' as const
            : 'carrier_markup' as const,
        }
      : null;
    const summary: ReturnOrderSummary = {
      returnId: row.returnId,
      returnReference: row.returnReference,
      status: row.status,
      createdAt: isoOrNull(row.createdAt),
      // Compatibility alias for historical rows remains visible, but all new
      // PS-437 rows prefer the canonical shipment tuple frozen by PrepShip.
      returnCustomerShippingRate: frozenMoney?.cShippingRateAmount ?? rate,
      money,
      items: normalizeItems(row.items),
      shipment: normalizeShipment(row.shipment),
    };
    const summaries = out.get(row.orderId);
    if (summaries) summaries.push(summary);
    else out.set(row.orderId, [summary]);
  }
  return out;
}
