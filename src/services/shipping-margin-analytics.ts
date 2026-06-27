import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { billingLineItems } from '../db/schema/billing';
import { clients } from '../db/schema/clients';
import { orderCompetitiveRate } from '../db/schema/order-competitive-rate';
import { shipments } from '../db/schema/shipments';
import { intArraySql, normalizeScopeIds } from '../lib/scope-sql';
import {
  isShippBrokeredServiceCode,
  SHIPP_BROKERED_ACCOUNT_LABEL,
} from './shipping-workflow/shipp-account-nickname-backfill';

export type ShippingMarginState = 'frozen_billing' | 'projected' | 'missing_billable';
export type ShippingMarginActualCostSource =
  | 'shipments.cost_plus_other_cost'
  | 'shipments.label_cost_plus_other_cost'
  | 'shipments.other_cost_only'
  | 'missing';
export type ShippingMarginBillableSource =
  | 'billing_line_items.shipping.total_cost'
  | 'order_competitive_rate.customer_rate'
  | 'projected.billing_policy'
  | 'missing';
export type ShippingMarginMissingProofReason =
  | 'missing_actual_cost'
  | 'missing_billable_shipping';
export type ShippingMarginAccountDisplaySource =
  | 'shipment_nickname'
  | 'carrier_resolver'
  | 'shipp_policy'
  | 'unknown';

export type ShippingMarginInputRow = {
  clientId: number | string | null;
  clientName: string | null;
  shipmentId: number | string | null;
  orderId: number | string | null;
  orderNumber: string | null;
  shipDate: Date | string | null;
  shipmentCost: string | number | null;
  shipmentLabelCost: string | number | null;
  shipmentOtherCost: string | number | null;
  billingLineItemId: number | string | null;
  billingTotalCost: string | number | null;
  projectedBillableAmount: string | number | null;
  projectedBillableSource: ShippingMarginBillableSource | null;
  houseCustomerRate: string | number | null;
  // PS-296: carrier/service/account identity for the breakdown + provider filter.
  carrierCode: string | null;
  serviceCode: string | null;
  providerAccountId: number | string | null;
  providerAccountNickname: string | null;
  resolvedProviderAccountNickname?: string | null;
};

export type ShippingMarginRow = {
  clientId: number | null;
  clientName: string;
  shipmentId: number | null;
  orderId: number | null;
  orderNumber: string | null;
  shipDate: string | null;
  actualShippingCost: number | null;
  actualCostSource: ShippingMarginActualCostSource;
  billableShippingAmount: number | null;
  billableSource: ShippingMarginBillableSource;
  state: ShippingMarginState;
  marginAmount: number | null;
  marginPct: number | null;
  billingLineItemId: number | null;
  houseCustomerRate: number | null;
  missingProofReasons: ShippingMarginMissingProofReason[];
  // PS-296: carrier/service/account identity (display-safe; no technical secrets).
  carrierCode: string | null;
  serviceCode: string | null;
  providerAccountId: number | null;
  providerAccountNickname: string | null;
  accountDisplayName: string;
  accountDisplaySource: ShippingMarginAccountDisplaySource;
};

export type ShippingMarginSummary = {
  rowCount: number;
  marginRowCount: number;
  frozenCount: number;
  projectedCount: number;
  missingBillableCount: number;
  missingActualCostCount: number;
  missingAnyProofCount: number;
  actualShippingTotal: number;
  billableShippingTotal: number;
  marginTotal: number;
  marginPct: number | null;
  // PS-296: operator-value metrics — negative-margin exceptions + averages.
  negativeMarginCount: number;
  negativeMarginTotal: number;
  averageActualShippingCost: number | null;
  averageBillableShipping: number | null;
};

export type ShippingMarginClientSummary = ShippingMarginSummary & {
  clientId: number | null;
  clientName: string;
};

// PS-296: per carrier/service/account rollup (parallel to the clients rollup) so the
// dashboard/billing can break margin down by provider and filter on it.
export type ShippingMarginCarrierSummary = ShippingMarginSummary & {
  carrierCode: string | null;
  serviceCode: string | null;
  providerAccountId: number | null;
  providerAccountNickname: string | null;
  accountDisplayName: string;
  accountDisplaySource: ShippingMarginAccountDisplaySource;
};

export type ShippingMarginAnalytics = {
  dateFrom: string;
  dateTo: string;
  summary: ShippingMarginSummary;
  clients: ShippingMarginClientSummary[];
  carriers: ShippingMarginCarrierSummary[];
  rows: ShippingMarginRow[];
};

export type ShippingMarginAnalyticsInput = {
  clientId?: number;
  storeId?: number;
  // PS-296: optional provider/account filter (DJ: "filterable by client/provider").
  providerAccountId?: number;
  dateFrom: string;
  dateTo: string;
  scopeClientIds?: number[];
  scopeStoreIds?: number[];
  scopeIsGlobal?: boolean;
  scopeRestricted?: boolean;
};

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed != null && Number.isInteger(parsed) ? parsed : null;
}

function money(value: number): number {
  return Number(value.toFixed(2));
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function percent(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function isoOrNull(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolveActualCost(row: ShippingMarginInputRow): {
  amount: number | null;
  source: ShippingMarginActualCostSource;
} {
  const shipmentCost = numberOrNull(row.shipmentCost);
  const labelCost = numberOrNull(row.shipmentLabelCost);
  const otherCost = numberOrNull(row.shipmentOtherCost) ?? 0;

  if (shipmentCost != null && shipmentCost > 0) {
    return { amount: money(shipmentCost + otherCost), source: 'shipments.cost_plus_other_cost' };
  }
  if (labelCost != null && labelCost > 0) {
    return { amount: money(labelCost + otherCost), source: 'shipments.label_cost_plus_other_cost' };
  }
  if (otherCost > 0) {
    return { amount: money(otherCost), source: 'shipments.other_cost_only' };
  }
  return { amount: null, source: 'missing' };
}

function resolveBillable(row: ShippingMarginInputRow): {
  amount: number | null;
  source: ShippingMarginBillableSource;
  state: ShippingMarginState;
} {
  const billingAmount = numberOrNull(row.billingTotalCost);
  if (row.billingLineItemId != null && billingAmount != null) {
    return {
      amount: money(billingAmount),
      source: 'billing_line_items.shipping.total_cost',
      state: 'frozen_billing',
    };
  }

  const explicitProjection = numberOrNull(row.projectedBillableAmount);
  if (explicitProjection != null) {
    return {
      amount: money(explicitProjection),
      source: row.projectedBillableSource ?? 'projected.billing_policy',
      state: 'projected',
    };
  }

  const houseCustomerRate = numberOrNull(row.houseCustomerRate);
  if (houseCustomerRate != null) {
    return {
      amount: money(houseCustomerRate),
      source: 'order_competitive_rate.customer_rate',
      state: 'projected',
    };
  }

  return { amount: null, source: 'missing', state: 'missing_billable' };
}

function isShippBrokeredMarginRow(row: ShippingMarginInputRow): boolean {
  const carrier = cleanText(row.carrierCode)?.toLowerCase();
  return carrier === 'shipp' || isShippBrokeredServiceCode(row.serviceCode);
}

export function resolveShippingMarginAccountDisplay(row: ShippingMarginInputRow): {
  name: string;
  source: ShippingMarginAccountDisplaySource;
} {
  const storedNickname = cleanText(row.providerAccountNickname);
  if (storedNickname) return { name: storedNickname, source: 'shipment_nickname' };

  const resolvedNickname = cleanText(row.resolvedProviderAccountNickname);
  if (resolvedNickname) return { name: resolvedNickname, source: 'carrier_resolver' };

  if (isShippBrokeredMarginRow(row)) return { name: SHIPP_BROKERED_ACCOUNT_LABEL, source: 'shipp_policy' };

  return intOrNull(row.providerAccountId) != null
    ? { name: 'Unresolved account', source: 'unknown' }
    : { name: 'Unknown account', source: 'unknown' };
}

export function buildShippingMarginRow(row: ShippingMarginInputRow): ShippingMarginRow {
  const actual = resolveActualCost(row);
  const billable = resolveBillable(row);
  const accountDisplay = resolveShippingMarginAccountDisplay(row);
  const margin =
    actual.amount != null && billable.amount != null
      ? money(billable.amount - actual.amount)
      : null;
  const missingProofReasons: ShippingMarginMissingProofReason[] = [];
  if (actual.amount == null) missingProofReasons.push('missing_actual_cost');
  if (billable.amount == null) missingProofReasons.push('missing_billable_shipping');
  return {
    clientId: intOrNull(row.clientId),
    clientName: row.clientName?.trim() || 'Unknown',
    shipmentId: intOrNull(row.shipmentId),
    orderId: intOrNull(row.orderId),
    orderNumber: row.orderNumber ?? null,
    shipDate: isoOrNull(row.shipDate),
    actualShippingCost: actual.amount,
    actualCostSource: actual.source,
    billableShippingAmount: billable.amount,
    billableSource: billable.source,
    state: billable.state,
    marginAmount: margin,
    marginPct: margin != null && actual.amount != null ? percent(margin, actual.amount) : null,
    billingLineItemId: intOrNull(row.billingLineItemId),
    houseCustomerRate: numberOrNull(row.houseCustomerRate),
    missingProofReasons,
    carrierCode: row.carrierCode?.trim() || null,
    serviceCode: row.serviceCode?.trim() || null,
    providerAccountId: intOrNull(row.providerAccountId),
    providerAccountNickname: row.providerAccountNickname?.trim() || null,
    accountDisplayName: accountDisplay.name,
    accountDisplaySource: accountDisplay.source,
  };
}

function emptySummary(): ShippingMarginSummary {
  return {
    rowCount: 0,
    marginRowCount: 0,
    frozenCount: 0,
    projectedCount: 0,
    missingBillableCount: 0,
    missingActualCostCount: 0,
    missingAnyProofCount: 0,
    actualShippingTotal: 0,
    billableShippingTotal: 0,
    marginTotal: 0,
    marginPct: null,
    negativeMarginCount: 0,
    negativeMarginTotal: 0,
    averageActualShippingCost: null,
    averageBillableShipping: null,
  };
}

function addRow(summary: ShippingMarginSummary, row: ShippingMarginRow): void {
  summary.rowCount += 1;
  if (row.state === 'frozen_billing') summary.frozenCount += 1;
  if (row.state === 'projected') summary.projectedCount += 1;
  if (row.state === 'missing_billable') summary.missingBillableCount += 1;
  if (row.actualShippingCost == null) summary.missingActualCostCount += 1;
  if (row.actualShippingCost == null || row.billableShippingAmount == null) summary.missingAnyProofCount += 1;

  if (row.actualShippingCost == null || row.billableShippingAmount == null || row.marginAmount == null) return;
  summary.marginRowCount += 1;
  summary.actualShippingTotal = money(summary.actualShippingTotal + row.actualShippingCost);
  summary.billableShippingTotal = money(summary.billableShippingTotal + row.billableShippingAmount);
  summary.marginTotal = money(summary.marginTotal + row.marginAmount);
  summary.marginPct = percent(summary.marginTotal, summary.actualShippingTotal);
  // PS-296: negative-margin exception tracking (a shipment billed BELOW its label cost).
  if (row.marginAmount < 0) {
    summary.negativeMarginCount += 1;
    summary.negativeMarginTotal = money(summary.negativeMarginTotal + row.marginAmount);
  }
}

// PS-296: averages over the rows that actually produced a margin (marginRowCount).
function finalizeSummaryAverages(summary: ShippingMarginSummary): void {
  summary.marginPct = percent(summary.marginTotal, summary.actualShippingTotal);
  summary.averageActualShippingCost =
    summary.marginRowCount > 0 ? money(summary.actualShippingTotal / summary.marginRowCount) : null;
  summary.averageBillableShipping =
    summary.marginRowCount > 0 ? money(summary.billableShippingTotal / summary.marginRowCount) : null;
}

function finalizeClientSummary(summary: ShippingMarginClientSummary): ShippingMarginClientSummary {
  finalizeSummaryAverages(summary);
  return summary;
}

function accountDisplayPriority(source: ShippingMarginAccountDisplaySource): number {
  if (source === 'shipment_nickname') return 3;
  if (source === 'carrier_resolver') return 2;
  if (source === 'shipp_policy') return 1;
  return 0;
}

function preferCarrierAccountDisplay(
  current: ShippingMarginCarrierSummary,
  row: ShippingMarginRow,
): void {
  if (accountDisplayPriority(row.accountDisplaySource) > accountDisplayPriority(current.accountDisplaySource)) {
    current.accountDisplayName = row.accountDisplayName;
    current.accountDisplaySource = row.accountDisplaySource;
  }
}

export function buildShippingMarginAnalytics(
  rows: ShippingMarginRow[],
  range: { dateFrom: string; dateTo: string },
): ShippingMarginAnalytics {
  const summary = emptySummary();
  const clientsById = new Map<string, ShippingMarginClientSummary>();
  const carriersByKey = new Map<string, ShippingMarginCarrierSummary>();

  for (const row of rows) {
    addRow(summary, row);
    const key = row.clientId == null ? `name:${row.clientName}` : `id:${row.clientId}`;
    let clientSummary = clientsById.get(key);
    if (!clientSummary) {
      clientSummary = {
        clientId: row.clientId,
        clientName: row.clientName,
        ...emptySummary(),
      };
      clientsById.set(key, clientSummary);
    }
    addRow(clientSummary, row);

    // PS-296: carrier/service/account rollup, keyed most-granular (carrier|service|account).
    const carrierKey = `${row.carrierCode ?? ''}|${row.serviceCode ?? ''}|${row.providerAccountId ?? ''}`;
    let carrierSummary = carriersByKey.get(carrierKey);
    if (!carrierSummary) {
      carrierSummary = {
        carrierCode: row.carrierCode,
        serviceCode: row.serviceCode,
        providerAccountId: row.providerAccountId,
        providerAccountNickname: row.providerAccountNickname,
        accountDisplayName: row.accountDisplayName,
        accountDisplaySource: row.accountDisplaySource,
        ...emptySummary(),
      };
      carriersByKey.set(carrierKey, carrierSummary);
    } else {
      preferCarrierAccountDisplay(carrierSummary, row);
    }
    addRow(carrierSummary, row);
  }

  finalizeSummaryAverages(summary);
  const clientsSummary = [...clientsById.values()]
    .map(finalizeClientSummary)
    .sort((a, b) => b.marginTotal - a.marginTotal || a.clientName.localeCompare(b.clientName));
  const carriersSummary = [...carriersByKey.values()]
    .map((carrier) => {
      finalizeSummaryAverages(carrier);
      return carrier;
    })
    .sort(
      (a, b) =>
        b.marginTotal - a.marginTotal ||
        (a.carrierCode ?? '').localeCompare(b.carrierCode ?? ''),
    );

  return {
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    summary,
    clients: clientsSummary,
    carriers: carriersSummary,
    rows,
  };
}

function shippingMarginScopePredicate(input: ShippingMarginAnalyticsInput): SQL {
  if (input.scopeIsGlobal === true) return sql`true`;

  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(input.scopeClientIds);
  const storeIds = normalizeScopeIds(input.scopeStoreIds);
  if (clientIds.length) {
    predicates.push(sql`${clients.id} = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`${clients.storeIds} && ${intArraySql(storeIds)}`);
  }
  if (!predicates.length) {
    return input.scopeRestricted ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

/**
 * Read-only shipping-margin analytics. This never regenerates billing, buys a
 * label, starts a queue job, or writes to shipped/cancelled data. Frozen rows
 * come from billing_line_items.shipping; unbilled SHIPP house rows may project
 * from the explicit order_competitive_rate customer_rate sidecar only.
 */
export async function shippingMarginAnalytics(
  input: ShippingMarginAnalyticsInput,
): Promise<ShippingMarginAnalytics> {
  const shippedAt = sql`coalesce(
    ${shipments.shipDate},
    ${shipments.labelShipDate},
    ${shipments.labelCreatedAt},
    ${shipments.createDate},
    ${shipments.createdAt}
  )`;
  const scopePredicate = shippingMarginScopePredicate(input);
  const rawRows = await db.execute<ShippingMarginInputRow>(sql`
    select
      coalesce(bli.client_id, ${shipments.clientId}) as "clientId",
      ${clients.name} as "clientName",
      ${shipments.id} as "shipmentId",
      ${shipments.orderId} as "orderId",
      ${shipments.orderNumber} as "orderNumber",
      ${shippedAt} as "shipDate",
      ${shipments.cost}::text as "shipmentCost",
      ${shipments.labelCost}::text as "shipmentLabelCost",
      ${shipments.otherCost}::text as "shipmentOtherCost",
      bli.billing_line_item_id as "billingLineItemId",
      bli.billing_total_cost as "billingTotalCost",
      null::numeric as "projectedBillableAmount",
      null::text as "projectedBillableSource",
      ${orderCompetitiveRate.customerRate}::text as "houseCustomerRate",
      ${shipments.carrierCode} as "carrierCode",
      ${shipments.serviceCode} as "serviceCode",
      ${shipments.providerAccountId} as "providerAccountId",
      ${shipments.providerAccountNickname} as "providerAccountNickname",
      provider_account_names.provider_account_nickname as "resolvedProviderAccountNickname"
    from ${shipments}
    left join (
      select
        provider_account_id,
        max(nullif(btrim(provider_account_nickname), '')) as provider_account_nickname
      from shipments
      where provider_account_id is not null
        and nullif(btrim(provider_account_nickname), '') is not null
      group by provider_account_id
    ) provider_account_names
      on provider_account_names.provider_account_id = ${shipments.providerAccountId}
    left join (
      select
        ${billingLineItems.shipmentId} as shipment_id,
        max(${billingLineItems.clientId}) as client_id,
        min(${billingLineItems.id}) as billing_line_item_id,
        sum(${billingLineItems.totalCost})::text as billing_total_cost
      from ${billingLineItems}
      where ${billingLineItems.lineType} = 'shipping'
      group by ${billingLineItems.shipmentId}
    ) bli on bli.shipment_id = ${shipments.id}
    left join ${clients} on ${clients.id} = coalesce(bli.client_id, ${shipments.clientId})
    left join ${orderCompetitiveRate}
      on ${orderCompetitiveRate.shipmentId} = ${shipments.id}
     and ${orderCompetitiveRate.isHouseOrder} = true
    where coalesce(${shipments.voided}, false) = false
      and coalesce(${shipments.isReturn}, false) = false
      and ${shippedAt} >= ${input.dateFrom}::timestamptz
      and ${shippedAt} < ${input.dateTo}::timestamptz
      ${input.clientId !== undefined ? sql`and coalesce(bli.client_id, ${shipments.clientId}) = ${input.clientId}` : sql``}
      ${input.storeId !== undefined ? sql`and ${clients.storeIds} && ${intArraySql([input.storeId])}` : sql``}
      ${input.providerAccountId !== undefined ? sql`and ${shipments.providerAccountId} = ${input.providerAccountId}` : sql``}
      and ${scopePredicate}
    order by ${shippedAt} desc, ${shipments.id} desc
  `);

  return buildShippingMarginAnalytics(
    rawRows.map((row) => buildShippingMarginRow(row)),
    { dateFrom: input.dateFrom, dateTo: input.dateTo },
  );
}
