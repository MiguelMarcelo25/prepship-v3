import type { DashboardProvenance } from '../lib/analytics-provenance';

export type DashboardSummaryFinancialPayload = {
  revenue: number | null;
  units: number;
  bySku: Array<{
    sku: string;
    revenue: number | string | null;
    units30: number | string;
    units7: number | string;
  }>;
  dailyRevenue: Array<{ day: string; revenue: number | string | null }>;
  canViewFinancials: boolean;
  meta?: DashboardProvenance;
};

// PS-421: the backend read-model boundary owns financial visibility. Dashboard
// routes cache and serialize only this result; the frontend never decides
// whether revenue should be visible.
export function dashboardSummaryForFinancialViewer(
  payload: Omit<DashboardSummaryFinancialPayload, 'canViewFinancials'>,
  canViewFinancials: boolean,
): DashboardSummaryFinancialPayload {
  if (canViewFinancials) return { ...payload, canViewFinancials: true };
  return {
    ...payload,
    canViewFinancials: false,
    revenue: null,
    bySku: payload.bySku.map((row) => ({ ...row, revenue: null })),
    dailyRevenue: payload.dailyRevenue.map((row) => ({ ...row, revenue: null })),
  };
}

export function dashboardDailyRevenueForFinancialViewer<
  T extends { revenue: number },
>(
  rows: T[],
  canViewFinancials: boolean,
): Array<Omit<T, 'revenue'> & { revenue: number | null }> {
  if (canViewFinancials) return rows;
  return rows.map((row) => ({ ...row, revenue: null }));
}
