export type ShippingRateRequestFingerprintInput = {
  version: string;
  shipDateBucket: string;
  weightOz: number;
  toZip: string;
  toCountry?: string | null;
  toState?: string | null;
  toCity?: string | null;
  residential?: boolean | null;
  clientId?: number | null;
  storeId?: number | null;
  sourceClientId?: number | null;
  apiKeyFingerprint?: string | null;
  dimsL?: number | null;
  dimsW?: number | null;
  dimsH?: number | null;
  confirmation?: string | null;
  insuranceProvider?: string | null;
  insuredValue?: number | null;
  carrierIds?: string[] | null;
  automationRulesVersion?: string | null;
};

export type SelectedRateValidationReason =
  | 'ok'
  | 'missing_selected_rate'
  | 'missing_current_fingerprint'
  | 'missing_fingerprint'
  | 'fingerprint_mismatch'
  | 'not_in_current_eligible_rates';

export type SelectedRateValidationResult =
  | {
      ok: true;
      reason: 'ok';
      selectedAuthorityKey: string;
    }
  | {
      ok: false;
      reason: Exclude<SelectedRateValidationReason, 'ok'>;
      selectedAuthorityKey: string | null;
    };

function normalizeZip(zip: string): string {
  const digits = String(zip ?? '').replace(/\D/g, '').slice(0, 5);
  return digits || String(zip ?? '').trim().toUpperCase();
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

function moneyKey(value: unknown): string {
  const n = finiteNumber(value ?? 0) ?? 0;
  return n.toFixed(4);
}

function providerAccountKey(value: unknown): string {
  const text = String(value ?? '').trim();
  const match = text.match(/^se-(\d+)$/i);
  if (match?.[1]) return match[1];
  const n = finiteNumber(text);
  return n != null ? String(Math.trunc(n)) : textKey(text);
}

function nestedAmount(rate: Record<string, unknown>, key: string): unknown {
  const amount = record(rate[key]);
  return amount?.amount;
}

function firstPresent(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

export function buildShippingRateRequestFingerprint(input: ShippingRateRequestFingerprintInput): string {
  const parts: string[] = [
    `v=${input.version}`,
    `d=${input.shipDateBucket}`,
    `w=${Math.round(input.weightOz * 10)}`,
    `z=${normalizeZip(input.toZip)}`,
    `co=${(input.toCountry ?? 'US').toUpperCase()}`,
  ];
  if (input.toState) parts.push(`st=${input.toState.trim().toUpperCase()}`);
  if (input.toCity) parts.push(`ci=${input.toCity.trim().toLowerCase().replace(/\s+/g, '-')}`);
  if (input.residential === true) parts.push('r=1');
  else if (input.residential === false) parts.push('r=0');
  if (input.clientId != null) parts.push(`cl=${input.clientId}`);
  else if (input.storeId != null) parts.push(`st=${input.storeId}`);
  if (input.sourceClientId != null) parts.push(`src=${input.sourceClientId}`);
  else if (input.apiKeyFingerprint) parts.push(`ak=${input.apiKeyFingerprint}`);
  if (input.dimsL) parts.push(`l=${Math.round(input.dimsL * 10)}`);
  if (input.dimsW) parts.push(`dw=${Math.round(input.dimsW * 10)}`);
  if (input.dimsH) parts.push(`h=${Math.round(input.dimsH * 10)}`);
  if (input.confirmation) parts.push(`cf=${input.confirmation}`);
  if (input.insuranceProvider && input.insuranceProvider !== 'none') {
    parts.push(`ip=${input.insuranceProvider}`);
    parts.push(`iv=${Math.round((input.insuredValue ?? 0) * 100)}`);
  }
  if (Array.isArray(input.carrierIds)) {
    parts.push(`c=${[...input.carrierIds].sort().join(',')}`);
  }
  if (input.automationRulesVersion) parts.push(`ar=${input.automationRulesVersion}`);
  return parts.join('|');
}

export function selectedRateRequestFingerprint(rate: unknown): string | null {
  const row = record(rate);
  if (!row) return null;
  const raw = record(row.raw);
  const metadata = record(row.metadata);
  const value = firstPresent(
    row.requestFingerprint,
    row.rateRequestFingerprint,
    row.cacheKey,
    metadata?.requestFingerprint,
    metadata?.cacheKey,
    raw?.requestFingerprint,
    raw?.cacheKey,
  );
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function selectedRateAuthorityKey(rate: unknown): string {
  const row = record(rate) ?? {};
  const raw = record(row.raw) ?? {};
  const provider = providerAccountKey(firstPresent(
    row.shippingProviderId,
    row.providerAccountId,
    row.shipping_provider_id,
    row.carrier_id,
    row.carrierId,
    raw.shippingProviderId,
    raw.providerAccountId,
    raw.carrier_id,
  ));
  const carrier = textKey(firstPresent(row.carrierCode, row.carrier_code, raw.carrierCode, raw.carrier_code));
  const service = textKey(firstPresent(row.serviceCode, row.service_code, raw.serviceCode, raw.service_code, row.serviceName, raw.service_type));
  const packageKey = textKey(firstPresent(row.packageCode, row.package_type, raw.packageCode, raw.package_type));
  const shipmentCost = firstPresent(
    row.shipmentCost,
    row.cost,
    nestedAmount(row, 'shipping_amount'),
    nestedAmount(raw, 'shipping_amount'),
  );
  const otherCost = firstPresent(
    row.otherCost,
    nestedAmount(row, 'other_amount'),
    nestedAmount(raw, 'other_amount'),
    0,
  );
  const confirmationCost = firstPresent(
    nestedAmount(row, 'confirmation_amount'),
    nestedAmount(raw, 'confirmation_amount'),
    0,
  );
  const insuranceCost = firstPresent(
    nestedAmount(row, 'insurance_amount'),
    nestedAmount(raw, 'insurance_amount'),
    0,
  );
  return [
    provider,
    carrier,
    service,
    packageKey,
    moneyKey(shipmentCost),
    moneyKey(otherCost),
    moneyKey(confirmationCost),
    moneyKey(insuranceCost),
  ].join('|');
}

export function validateExactSelectedRate(input: {
  currentRequestFingerprint: string | null | undefined;
  selectedRate: unknown;
  eligibleRates?: unknown[] | null;
}): SelectedRateValidationResult {
  if (!input.currentRequestFingerprint) {
    return { ok: false, reason: 'missing_current_fingerprint', selectedAuthorityKey: null };
  }
  if (!input.selectedRate) {
    return { ok: false, reason: 'missing_selected_rate', selectedAuthorityKey: null };
  }

  const selectedAuthorityKey = selectedRateAuthorityKey(input.selectedRate);
  const selectedFingerprint = selectedRateRequestFingerprint(input.selectedRate);
  if (!selectedFingerprint) {
    return { ok: false, reason: 'missing_fingerprint', selectedAuthorityKey };
  }
  if (selectedFingerprint !== input.currentRequestFingerprint) {
    return { ok: false, reason: 'fingerprint_mismatch', selectedAuthorityKey };
  }

  if (Array.isArray(input.eligibleRates) && input.eligibleRates.length > 0) {
    const eligibleKeys = new Set(input.eligibleRates.map((rate) => selectedRateAuthorityKey(rate)));
    if (!eligibleKeys.has(selectedAuthorityKey)) {
      return { ok: false, reason: 'not_in_current_eligible_rates', selectedAuthorityKey };
    }
  }

  return { ok: true, reason: 'ok', selectedAuthorityKey };
}
