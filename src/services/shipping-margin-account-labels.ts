import type { ShippingMarginInputRow } from './shipping-margin-analytics';
import { isShippBrokeredServiceCode } from './shipping-workflow/shipp-account-nickname-backfill';

export type ShippingMarginAccountNicknameResolver = (
  providerAccountId: number | null,
  carrierCode: string | null,
  trackingNumber?: string | null,
  clientId?: number | null,
) => Promise<string | null>;

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function needsResolver(row: ShippingMarginInputRow): boolean {
  if (cleanText(row.providerAccountNickname)) return false;
  if (cleanText(row.resolvedProviderAccountNickname)) return false;
  if (cleanText(row.carrierCode)?.toLowerCase() === 'shipp') return false;
  if (isShippBrokeredServiceCode(row.serviceCode)) return false;
  return cleanText(row.carrierCode) != null && (
    intOrNull(row.providerAccountId) != null ||
    cleanText(row.trackingNumber) != null
  );
}

function resolverCacheKey(row: ShippingMarginInputRow): string {
  const providerAccountId = intOrNull(row.providerAccountId);
  const carrierCode = cleanText(row.carrierCode)?.toLowerCase() ?? '';
  const clientId = intOrNull(row.clientId);
  if (providerAccountId != null) return `${providerAccountId}|${carrierCode}|${clientId ?? ''}`;
  return `tracking|${carrierCode}|${cleanText(row.trackingNumber)?.toUpperCase() ?? ''}|${clientId ?? ''}`;
}

const defaultResolveCarrierNickname: ShippingMarginAccountNicknameResolver = async (...args) => {
  const { resolveCarrierNickname } = await import('./labels');
  return resolveCarrierNickname(...args);
};

export async function resolveShippingMarginAccountLabels(
  rows: readonly ShippingMarginInputRow[],
  resolver: ShippingMarginAccountNicknameResolver = defaultResolveCarrierNickname,
): Promise<ShippingMarginInputRow[]> {
  const cache = new Map<string, Promise<string | null>>();

  return Promise.all(rows.map(async (row) => {
    if (!needsResolver(row)) return row;

    const key = resolverCacheKey(row);
    let pending = cache.get(key);
    if (!pending) {
      pending = resolver(
        intOrNull(row.providerAccountId),
        cleanText(row.carrierCode),
        cleanText(row.trackingNumber),
        intOrNull(row.clientId),
      );
      cache.set(key, pending);
    }

    const resolved = cleanText(await pending);
    return resolved ? { ...row, resolvedProviderAccountNickname: resolved } : row;
  }));
}
