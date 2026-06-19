export type CarrierRecipientNameSource = 'name' | 'company' | 'email' | 'fallback';

export type CarrierRecipientNameInput = {
  name?: string | null;
  company?: string | null;
  customerEmail?: string | null;
};

export type CarrierRecipientNameResult = {
  name: string;
  company: string | undefined;
  source: CarrierRecipientNameSource;
  changed: boolean;
  originalName: string | null;
};

const COMBINING_MARKS = /[\u0300-\u036f]/g;
const CARRIER_UNSAFE_CHARS = /[^A-Za-z0-9 .,'&#/()-]+/g;
const EDGE_PUNCTUATION = /^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g;

function normalizeCarrierText(value: unknown): string {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
  const normalized = raw
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(CARRIER_UNSAFE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EDGE_PUNCTUATION, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /[A-Za-z0-9]/.test(normalized) ? normalized : '';
}

function emailLocalPart(email: string | null | undefined): string {
  const value = String(email ?? '').trim();
  if (!value) return '';
  return value.split('@', 1)[0] ?? '';
}

export function resolveCarrierRecipientName(input: CarrierRecipientNameInput): CarrierRecipientNameResult {
  const originalName = typeof input.name === 'string' ? input.name : input.name == null ? null : String(input.name);
  const safeName = normalizeCarrierText(input.name);
  const safeCompany = normalizeCarrierText(input.company);
  const safeEmailLocal = normalizeCarrierText(emailLocalPart(input.customerEmail));

  let name = safeName;
  let source: CarrierRecipientNameSource = 'name';
  if (!name && safeCompany) {
    name = safeCompany;
    source = 'company';
  } else if (!name && safeEmailLocal) {
    name = safeEmailLocal;
    source = 'email';
  } else if (!name) {
    name = 'Customer';
    source = 'fallback';
  }

  return {
    name,
    company: safeCompany || undefined,
    source,
    changed: name !== String(originalName ?? '').trim() || safeCompany !== String(input.company ?? '').trim(),
    originalName,
  };
}

export const __test_normalizeCarrierRecipientText = normalizeCarrierText;
