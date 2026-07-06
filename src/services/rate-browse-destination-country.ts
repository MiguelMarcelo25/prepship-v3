export type RateBrowseDestinationCountryInput = {
  requestedCountry?: unknown;
  canonicalCountry?: unknown;
};

function normalizeRateBrowseCountry(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const compact = raw.replace(/[\s._-]+/g, '').toUpperCase();
  if (compact === 'USA' || compact === 'UNITEDSTATES' || compact === 'UNITEDSTATESOFAMERICA') {
    return 'US';
  }
  if (compact === 'CAN' || compact === 'CANADA') {
    return 'CA';
  }
  if (/^[A-Z]{2}$/.test(compact)) {
    return compact;
  }

  return raw.toUpperCase();
}

export function resolveRateBrowseDestinationCountry({
  requestedCountry,
  canonicalCountry,
}: RateBrowseDestinationCountryInput): string {
  const requested = normalizeRateBrowseCountry(requestedCountry);
  const canonical = normalizeRateBrowseCountry(canonicalCountry);

  if (canonical && canonical !== 'US' && (!requested || requested === 'US')) {
    return canonical;
  }

  return requested ?? canonical ?? 'US';
}
