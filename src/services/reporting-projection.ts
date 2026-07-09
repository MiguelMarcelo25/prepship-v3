import { sql, type SQL } from 'drizzle-orm';
import {
  CALIFORNIA_TIME_ZONE,
  californiaDayEnd,
  californiaDayStart,
} from '../lib/time/california';

const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

export type ReportingWindow = {
  timeZone: typeof CALIFORNIA_TIME_ZONE;
  fromDay: string;
  toDay: string;
  dateFrom: string;
  dateToInclusive: string;
  dateToExclusive: string;
};

export type ReportingFinancialState = 'available' | 'incomplete' | 'forbidden';

export type AnalysisSkuFinancialProjection = {
  financialsState: ReportingFinancialState;
  standardAvgShipping: number | null;
  expeditedAvgShipping: number | null;
  blendedAvgShipping: number | null;
  totalShipping: number | null;
  totalRevenue: number | null;
  avgSellingPrice: number | null;
  totalSellingFee: number | null;
  profit: number | null;
};

export type AnalysisSkuReportingTotals = {
  skuCount: number;
  totalOrders: number;
  totalPending: number;
  totalExternal: number;
  totalQty: number;
  totalStdCount: number;
  totalExpCount: number;
  totalStdQty: number;
  totalExpQty: number;
  totalStdShipping: number | null;
  totalExpShipping: number | null;
  standardAvgShipping: number | null;
  expeditedAvgShipping: number | null;
  totalShipping: number | null;
  totalRevenue: number | null;
  avgSellingPrice: number | null;
  totalSellingFee: number | null;
  totalProfit: number | null;
  financialsState: ReportingFinancialState;
};

function reportingDay(value: string, field: string): string {
  const day = DAY_PREFIX.exec(value.trim())?.[1];
  if (!day || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) {
    throw new Error(`${field} must start with a valid YYYY-MM-DD date`);
  }
  return day;
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function buildReportingWindow(input: { from: string; to: string }): ReportingWindow {
  const fromDay = reportingDay(input.from, 'from');
  const toDay = reportingDay(input.to, 'to');
  if (fromDay > toDay) throw new Error('from must not be after to');

  return {
    timeZone: CALIFORNIA_TIME_ZONE,
    fromDay,
    toDay,
    dateFrom: californiaDayStart(fromDay).toISOString(),
    dateToInclusive: californiaDayEnd(toDay).toISOString(),
    dateToExclusive: californiaDayStart(nextDay(toDay)).toISOString(),
  };
}

export function buildReportingDateBuckets(window: Pick<ReportingWindow, 'fromDay' | 'toDay'>): string[] {
  const startMs = Date.parse(`${window.fromDay}T00:00:00.000Z`);
  const endMs = Date.parse(`${window.toDay}T00:00:00.000Z`);
  const days = Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1);
  return Array.from({ length: days }, (_, index) =>
    new Date(startMs + index * 86_400_000).toISOString().slice(0, 10),
  );
}

export const REPORTING_EXPEDITED_SERVICES = [
  'ups_2nd_day_air', 'ups_2nd_day_air_am',
  'ups_next_day_air', 'ups_next_day_air_saver', 'ups_next_day_air_early_am',
  'ups_3_day_select',
  'usps_priority_mail_express',
  'fedex_2day', 'fedex_2day_am',
  'fedex_express_saver',
  'fedex_priority_overnight', 'fedex_standard_overnight', 'fedex_first_overnight',
] as const;

export const REPORTING_EXPEDITED_SERVICES_SQL = sql`ARRAY[${sql.join(
  REPORTING_EXPEDITED_SERVICES.map((service) => sql`${service}`),
  sql`, `,
)}]::text[]`;

/**
 * Shared read-only purchased-cost projection. Persisted selected_rate_cost is
 * authoritative; legacy component columns are null-safety for unbackfilled rows.
 */
export function reportingShipmentCostJoinSql(shipmentAlias = 's'): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(shipmentAlias)) {
    throw new Error('Invalid shipment SQL alias');
  }
  const column = (name: string) => sql.raw(`${shipmentAlias}.${name}`);
  return sql`
    cross join lateral (
      select
        round(
          case
            when ${column('selected_rate_cost')} is not null
              then ${column('selected_rate_cost')}::numeric
            when ${column('cost')} is not null
              then ${column('cost')}::numeric + coalesce(${column('other_cost')}, 0)::numeric
            when ${column('label_cost')} is not null
              then ${column('label_cost')}::numeric + coalesce(${column('other_cost')}, 0)::numeric
            when coalesce(${column('other_cost')}, 0)::numeric > 0
              then ${column('other_cost')}::numeric
            else null::numeric
          end,
          2
        ) as selected_cost
    ) reporting_cost on true
  `;
}

/**
 * Canonical per-order shipment projection for SKU reporting. It keeps every
 * non-voided purchased label and classifies each label before aggregation, so
 * a multi-label order cannot assign all cost to only its newest service.
 */
export function reportingOrderShipmentProjectionJoinSql(
  orderIdExpression: SQL,
  projectionAlias = 'reporting_shipment',
): SQL {
  if (!/^[a-z_][a-z0-9_]*$/i.test(projectionAlias)) {
    throw new Error('Invalid reporting shipment projection SQL alias');
  }
  const alias = sql.raw(projectionAlias);
  return sql`
    left join lateral (
      select
        max(s.order_id) as order_id,
        (array_agg(s.service_code order by s.id desc))[1] as service_code,
        coalesce(sum(reporting_cost.selected_cost), 0) as selected_cost,
        coalesce(sum(reporting_cost.selected_cost) filter (
          where lower(coalesce(s.service_code, '')) = any(${REPORTING_EXPEDITED_SERVICES_SQL})
        ), 0) as expedited_cost,
        coalesce(sum(reporting_cost.selected_cost) filter (
          where lower(coalesce(s.service_code, '')) <> all(${REPORTING_EXPEDITED_SERVICES_SQL})
        ), 0) as standard_cost
      from shipments s
      ${reportingShipmentCostJoinSql('s')}
      where s.order_id = ${orderIdExpression}
        and coalesce(s.voided, false) = false
    ) ${alias} on true
  `;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function money(value: number): number {
  return Number(value.toFixed(2));
}

export function projectAnalysisSkuFinancials(
  row: Record<string, unknown>,
  canViewFinancials: boolean,
): AnalysisSkuFinancialProjection {
  if (!canViewFinancials) {
    return {
      financialsState: 'forbidden',
      standardAvgShipping: null,
      expeditedAvgShipping: null,
      blendedAvgShipping: null,
      totalShipping: null,
      totalRevenue: null,
      avgSellingPrice: null,
      totalSellingFee: null,
      profit: null,
    };
  }

  const standardShipping = numberOrZero(row.std_total);
  const standardQty = numberOrZero(row.std_qty_total);
  const expeditedShipping = numberOrZero(row.exp_total);
  const expeditedQty = numberOrZero(row.exp_qty_total);
  const totalShipping = numberOrZero(row.total_shipping);
  const shipCountWithCost = numberOrZero(row.ship_count_with_cost);
  const totalRevenue = numberOrZero(row.total_revenue);
  const totalQty = numberOrZero(row.total_qty);
  const totalSellingFee = numberOrZero(row.total_selling_fee);
  const hasRevenue = totalQty > 0 && totalRevenue > 0;
  const hasCompleteFees = row.selling_fee_complete === true;
  const hasCompleteFinancials = hasRevenue && hasCompleteFees;

  return {
    financialsState: hasCompleteFinancials ? 'available' : 'incomplete',
    standardAvgShipping: standardQty > 0 ? money(standardShipping / standardQty) : null,
    expeditedAvgShipping: expeditedQty > 0 ? money(expeditedShipping / expeditedQty) : null,
    blendedAvgShipping: shipCountWithCost > 0 ? money(totalShipping / shipCountWithCost) : null,
    totalShipping: money(totalShipping),
    totalRevenue: money(totalRevenue),
    avgSellingPrice: hasRevenue ? money(totalRevenue / totalQty) : null,
    totalSellingFee: hasCompleteFees ? money(totalSellingFee) : null,
    profit: hasCompleteFinancials
      ? money(totalRevenue - totalShipping - totalSellingFee)
      : null,
  };
}

export function projectAnalysisSkuTotals(
  rows: Array<Record<string, unknown> & AnalysisSkuFinancialProjection>,
  canViewFinancials: boolean,
): AnalysisSkuReportingTotals {
  const totals = rows.reduce(
    (sum, row) => ({
      skuCount: sum.skuCount + 1,
      totalOrders: sum.totalOrders + numberOrZero(row.orders),
      totalPending: sum.totalPending + numberOrZero(row.pending),
      totalExternal: sum.totalExternal + numberOrZero(row.ext_shipped),
      totalQty: sum.totalQty + numberOrZero(row.total_qty),
      totalStdCount: sum.totalStdCount + numberOrZero(row.std_ship_count),
      totalExpCount: sum.totalExpCount + numberOrZero(row.exp_ship_count),
      totalStdQty: sum.totalStdQty + numberOrZero(row.std_qty_total),
      totalExpQty: sum.totalExpQty + numberOrZero(row.exp_qty_total),
      totalStdShipping: sum.totalStdShipping + numberOrZero(row.std_total),
      totalExpShipping: sum.totalExpShipping + numberOrZero(row.exp_total),
      totalShipping: sum.totalShipping + (row.totalShipping ?? 0),
      totalRevenue: sum.totalRevenue + (row.totalRevenue ?? 0),
      totalSellingFee: sum.totalSellingFee + (row.totalSellingFee ?? 0),
      totalProfit: sum.totalProfit + (row.profit ?? 0),
      allFeesComplete: sum.allFeesComplete && row.totalSellingFee !== null,
      allFinancialsComplete: sum.allFinancialsComplete && row.financialsState === 'available',
    }),
    {
      skuCount: 0,
      totalOrders: 0,
      totalPending: 0,
      totalExternal: 0,
      totalQty: 0,
      totalStdCount: 0,
      totalExpCount: 0,
      totalStdQty: 0,
      totalExpQty: 0,
      totalStdShipping: 0,
      totalExpShipping: 0,
      totalShipping: 0,
      totalRevenue: 0,
      totalSellingFee: 0,
      totalProfit: 0,
      allFeesComplete: true,
      allFinancialsComplete: true,
    },
  );

  const financialsState: ReportingFinancialState = !canViewFinancials
    ? 'forbidden'
    : rows.length > 0 && totals.allFinancialsComplete
      ? 'available'
      : 'incomplete';
  const financial = <T>(value: T): T | null => canViewFinancials ? value : null;

  return {
    skuCount: totals.skuCount,
    totalOrders: totals.totalOrders,
    totalPending: totals.totalPending,
    totalExternal: totals.totalExternal,
    totalQty: totals.totalQty,
    totalStdCount: totals.totalStdCount,
    totalExpCount: totals.totalExpCount,
    totalStdQty: totals.totalStdQty,
    totalExpQty: totals.totalExpQty,
    totalStdShipping: financial(money(totals.totalStdShipping)),
    totalExpShipping: financial(money(totals.totalExpShipping)),
    standardAvgShipping: financial(
      totals.totalStdQty > 0
        ? money(totals.totalStdShipping / totals.totalStdQty)
        : null,
    ),
    expeditedAvgShipping: financial(
      totals.totalExpQty > 0
        ? money(totals.totalExpShipping / totals.totalExpQty)
        : null,
    ),
    totalShipping: financial(money(totals.totalShipping)),
    totalRevenue: financial(money(totals.totalRevenue)),
    avgSellingPrice: financial(
      totals.totalQty > 0 && totals.totalRevenue > 0
        ? money(totals.totalRevenue / totals.totalQty)
        : null,
    ),
    totalSellingFee: financial(
      rows.length > 0 && totals.allFeesComplete
        ? money(totals.totalSellingFee)
        : null,
    ),
    totalProfit: financial(
      financialsState === 'available'
        ? money(totals.totalProfit)
        : null,
    ),
    financialsState,
  };
}
