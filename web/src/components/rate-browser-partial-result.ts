import { sortRateRowsByBackendDisplayRank } from '../lib/rate-browser-money';
import type {
  CarrierRateStatus,
  RateRow,
  RbCarrierAccountDto,
} from './RateBrowserModal';

type PartialCarrierStatus = {
  carrierId?: string | null;
  status?: CarrierRateStatus;
  error?: string | null;
  durationMs?: number | string | null;
};

type PartialCarrierError = {
  shippingProviderId?: number | string | null;
  message?: string | null;
};

type PartialCarrierTiming = {
  carrierId?: string | null;
  durationMs?: number | string | null;
};

export type PartialRateBrowseDisplayState = {
  ratesByPid: Record<string, RateRow[]>;
  errorsByPid: Record<string, string>;
  timingByPid: Record<string, number>;
  statusByPid: Record<string, CarrierRateStatus>;
  info: {
    source: 'cache' | 'live' | 'mixed' | null;
    cacheAgeMs?: number;
  };
};

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function rateRowTextKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

function rateRowMoneyKey(value: unknown): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toFixed(4) : '0.0000';
}

function rateRowDedupeKey(rate: RateRow): string {
  const raw = rate.raw ?? {};
  const amount = toFiniteNumber(rate.amount) ?? toFiniteNumber(raw?.amount) ?? 0;
  const shipmentCost = toFiniteNumber(rate.shipmentCost) ?? toFiniteNumber(raw?.shipmentCost) ?? 0;
  const otherCost = toFiniteNumber(rate.otherCost) ?? toFiniteNumber(raw?.otherCost) ?? 0;
  return [
    rateRowTextKey(rate.shippingProviderId ?? raw?.carrier_id),
    rateRowTextKey(rate.carrierCode ?? raw?.carrier_code),
    rateRowTextKey(rate.serviceCode ?? raw?.service_code ?? rate.serviceName ?? raw?.service_type),
    rateRowMoneyKey(amount),
    rateRowMoneyKey(shipmentCost),
    rateRowMoneyKey(otherCost),
    rateRowTextKey((rate as any).estimatedDelivery ?? raw?.estimated_delivery_date ?? (rate as any).deliveryDays ?? raw?.delivery_days),
  ].join('|');
}

function dedupeRateRows(rates: RateRow[]): RateRow[] {
  const byKey = new Map<string, RateRow>();
  for (const rate of rates) {
    const key = rateRowDedupeKey(rate);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, rate);
      continue;
    }
    if (!existing.raw?.rate_id && rate.raw?.rate_id) {
      byKey.set(key, rate);
    }
  }
  return [...byKey.values()];
}

function groupRatesByProviderId(rates: RateRow[]): Record<string, RateRow[]> {
  return rates.reduce<Record<string, RateRow[]>>((acc, rate) => {
    if (rate.shippingProviderId == null) return acc;
    const key = String(rate.shippingProviderId);
    const bucket = (acc[key] ??= []);
    if (!bucket.some((existing) => rateRowDedupeKey(existing) === rateRowDedupeKey(rate))) {
      bucket.push(rate);
    }
    return acc;
  }, {});
}

function rateBrowseSource(partialResult: Record<string, unknown>, visibleRatesCount: number) {
  return partialResult.source === 'cache' || partialResult.source === 'live' || partialResult.source === 'mixed'
    ? partialResult.source
    : partialResult.cached
      ? 'cache'
      : visibleRatesCount
        ? 'live'
        : null;
}

export function buildPartialRateBrowseDisplayState(input: {
  partialResult: Record<string, unknown>;
  accounts: RbCarrierAccountDto[];
  formatAccountDisplay: (account: RbCarrierAccountDto | undefined, fallback: string) => string;
}): PartialRateBrowseDisplayState | null {
  const { partialResult, accounts, formatAccountDisplay } = input;
  const raw = (Array.isArray(partialResult)
    ? partialResult
    : Array.isArray(partialResult.rates)
      ? partialResult.rates
      : []) as RateRow[];
  if (!raw.length) return null;

  const accountByPid = new Map(accounts.map((acct) => [acct.shippingProviderId, acct]));
  const accountByCarrierId = new Map(
    accounts
      .filter((acct) => typeof acct.carrierId === 'string' && acct.carrierId.length > 0)
      .map((acct) => [acct.carrierId as string, acct]),
  );

  const errorsByPid: Record<string, string> = {};
  const directErrors = Array.isArray(partialResult.directCarrierErrors)
    ? partialResult.directCarrierErrors as PartialCarrierError[]
    : [];
  for (const err of directErrors) {
    const pid = toFiniteNumber(err.shippingProviderId);
    const message = toOptionalString(err.message);
    if (pid != null && message) errorsByPid[String(pid)] = message;
  }

  const timingByPid: Record<string, number> = {};
  const timingCarriers = Array.isArray((partialResult as any).rateBrowseTiming?.carriers)
    ? (partialResult as any).rateBrowseTiming.carriers as PartialCarrierTiming[]
    : [];
  for (const timing of timingCarriers) {
    const carrierId = toOptionalString(timing.carrierId);
    const account = carrierId ? accountByCarrierId.get(carrierId) : undefined;
    const durationMs = toFiniteNumber(timing.durationMs);
    if (account && durationMs != null) {
      timingByPid[String(account.shippingProviderId)] = durationMs;
    }
  }

  const statusByPid: Record<string, CarrierRateStatus> = {};
  const carrierStatuses = Array.isArray(partialResult.carrierStatuses)
    ? partialResult.carrierStatuses as PartialCarrierStatus[]
    : [];
  for (const status of carrierStatuses) {
    if (!status.carrierId) continue;
    const account = accountByCarrierId.get(status.carrierId);
    if (!account) continue;
    const key = String(account.shippingProviderId);
    statusByPid[key] = status.status ?? 'unavailable';
    if (status.error) errorsByPid[key] = status.error;
    const durationMs = toFiniteNumber(status.durationMs);
    if (durationMs != null && timingByPid[key] == null) timingByPid[key] = durationMs;
  }

  const partialFetchedRates = sortRateRowsByBackendDisplayRank(dedupeRateRows(
    raw
      .map((rate) => {
        const pid =
          typeof rate.shippingProviderId === 'number'
            ? rate.shippingProviderId
            : Number(rate.shippingProviderId);
        const rawCarrierId = typeof rate.raw?.carrier_id === 'string' ? rate.raw.carrier_id : null;
        const account =
          (Number.isFinite(pid) ? accountByPid.get(pid) : undefined) ??
          (rawCarrierId ? accountByCarrierId.get(rawCarrierId) : undefined);
        return {
          ...rate,
          shippingProviderId: account?.shippingProviderId ?? rate.shippingProviderId,
          carrierNickname: rate.carrierNickname ?? formatAccountDisplay(account, ''),
        };
      })
      .filter((rate) => {
        const pid =
          typeof rate.shippingProviderId === 'number'
            ? rate.shippingProviderId
            : Number(rate.shippingProviderId);
        return Number.isFinite(pid) && accountByPid.has(pid);
      }),
  ));

  const grouped = groupRatesByProviderId(partialFetchedRates);
  const ratesByPid: Record<string, RateRow[]> = {};
  for (const acct of accounts) {
    const key = String(acct.shippingProviderId);
    const accountRates = grouped[key] ?? [];
    if (accountRates.length > 0) {
      ratesByPid[key] = accountRates;
      statusByPid[key] = partialResult.cached ? 'cached' : 'live';
    }
  }

  for (const [pid, message] of Object.entries(errorsByPid)) {
    if (message) statusByPid[pid] = 'error';
  }

  return {
    ratesByPid,
    errorsByPid,
    timingByPid,
    statusByPid,
    info: {
      source: rateBrowseSource(partialResult, raw.length),
      cacheAgeMs: typeof partialResult.cacheAgeMs === 'number' ? partialResult.cacheAgeMs : undefined,
    },
  };
}
