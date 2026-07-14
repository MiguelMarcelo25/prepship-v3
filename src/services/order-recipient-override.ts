export type OrderRecipientAddress = {
  name: string;
  company: string | null;
  street1: string;
  street2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string | null;
  addressVerified?: string | null;
};

export type OrderRecipientOverride = OrderRecipientAddress;

type RawRecipientInput = Record<string, unknown> | null | undefined;

export async function ensureOrderRecipientOverrideSchema(): Promise<void> {
  const { assertRuntimeSchemaReady } = await import('./runtime-schema-readiness.js');
  await assertRuntimeSchemaReady();
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned : null;
}

function requiredText(input: RawRecipientInput, key: keyof OrderRecipientAddress): string {
  const value = cleanText(input?.[key]);
  if (!value) throw new Error(`Recipient ${key} is required`);
  return value;
}

export function normalizeRecipientOverride(input: RawRecipientInput): OrderRecipientOverride {
  if (!input || typeof input !== 'object') {
    throw new Error('Recipient override is required');
  }

  const country = (cleanText(input.country) ?? 'US').toUpperCase();

  return {
    name: requiredText(input, 'name'),
    company: cleanText(input.company),
    street1: requiredText(input, 'street1'),
    street2: cleanText(input.street2),
    city: requiredText(input, 'city'),
    state: requiredText(input, 'state').toUpperCase(),
    postalCode: requiredText(input, 'postalCode'),
    country,
    phone: cleanText(input.phone),
    addressVerified: 'Not Validated',
  };
}

export function recipientOverrideFromRecord(value: unknown): OrderRecipientOverride | null {
  if (!value || typeof value !== 'object') return null;
  try {
    return normalizeRecipientOverride(value as RawRecipientInput);
  } catch {
    return null;
  }
}

export function resolveRecipientForShipping(input: {
  override?: unknown | null;
  rawShipTo?: RawRecipientInput;
  fallback?: {
    name?: unknown;
    city?: unknown;
    state?: unknown;
    postalCode?: unknown;
  } | null;
}): { source: 'override' | 'raw' | 'fallback'; address: OrderRecipientAddress } {
  const override = recipientOverrideFromRecord(input.override);
  if (override) {
    return { source: 'override', address: override };
  }

  const rawShipTo = input.rawShipTo ?? {};
  const fallback = input.fallback ?? {};
  const rawHasRecipientData = [
    rawShipTo.name,
    rawShipTo.company,
    rawShipTo.street1,
    rawShipTo.street2,
    rawShipTo.city,
    rawShipTo.state,
    rawShipTo.postalCode,
    rawShipTo.country,
    rawShipTo.phone,
  ].some((value) => cleanText(value) != null);

  return {
    source: rawHasRecipientData ? 'raw' : 'fallback',
    address: {
      name: cleanText(rawShipTo.name) ?? cleanText(fallback.name) ?? 'Customer',
      company: cleanText(rawShipTo.company),
      street1: cleanText(rawShipTo.street1) ?? '',
      street2: cleanText(rawShipTo.street2),
      city: cleanText(rawShipTo.city) ?? cleanText(fallback.city) ?? '',
      state: cleanText(rawShipTo.state) ?? cleanText(fallback.state) ?? '',
      postalCode: cleanText(rawShipTo.postalCode) ?? cleanText(fallback.postalCode) ?? '',
      country: (cleanText(rawShipTo.country) ?? 'US').toUpperCase(),
      phone: cleanText(rawShipTo.phone),
      addressVerified: cleanText(rawShipTo.addressVerified),
    },
  };
}
