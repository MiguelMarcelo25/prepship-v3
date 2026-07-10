export type CarrierIdentityAccount = {
  id: number;
  clientId?: number | null;
  provider: string;
  label?: string | null;
  accountIdentifier?: string | null;
  credentials?: Record<string, unknown> | null;
  active?: boolean | null;
};

export type StoreAccountIdentity = CarrierIdentityAccount & {
  credentials: Record<string, unknown>;
};

const STORE_SCOPED_PROVIDER_MAP = new Map<string, string>([
  ['walmart_shipping', 'walmart'],
  ['ebay_shipping', 'ebay'],
]);

const PROVIDER_LABELS: Record<string, string> = {
  walmart_shipping: 'Walmart Shipping',
  ebay_shipping: 'eBay Shipping',
  walmart: 'Walmart',
  ebay: 'eBay',
  shopify: 'Shopify',
  easypost: 'EasyPost',
  shipengine: 'ShipEngine',
  shipp: 'Shipp',
  ups: 'UPS',
  usps: 'USPS',
  fedex: 'FedEx',
  dhl_express: 'DHL Express',
};

const SAFE_IDENTITY_FIELDS: Record<string, string[]> = {
  ups: ['accountNumber'],
  fedex: ['accountNumber'],
  dhl_express: ['accountNumber'],
  usps: ['crid', 'mid'],
  amazon_shipping: ['sellerId'],
  seko: ['accountId'],
  epost_global: ['accountId'],
  intelliquick: ['accountNumber'],
  gls: ['customerId'],
  stamps_com: ['username'],
  endicia: ['accountId'],
  etsy: ['shopId'],
  tiktok_shop: ['shopId'],
  woocommerce: ['storeUrl'],
  bigcommerce: ['storeHash'],
  walmart: ['partnerId', 'sellerId'],
};

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

function finiteId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeShopifyDomain(value: unknown): string | null {
  const raw = text(value)?.toLowerCase();
  if (!raw) return null;
  const host = raw
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    ?.replace(/\.+$/, '');
  return host && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host) ? host : null;
}

export function normalizeCarrierIdentityProvider(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function baseStoreProviderForShippingProvider(provider: unknown): string | null {
  return STORE_SCOPED_PROVIDER_MAP.get(normalizeCarrierIdentityProvider(provider)) ?? null;
}

export function isStoreScopedCarrierProvider(provider: unknown): boolean {
  return baseStoreProviderForShippingProvider(provider) != null;
}

export function isDirectShippingAccount(
  provider: unknown,
  sourceTable: 'carrier_accounts' | 'store_accounts',
): boolean {
  return sourceTable === 'carrier_accounts' || normalizeCarrierIdentityProvider(provider).endsWith('_shipping');
}

export function carrierStoreLinkIdentifier(storeAccountId: number): string {
  const id = finiteId(storeAccountId);
  if (id == null) throw new Error('A valid storeAccountId is required.');
  return `store:${id}`;
}

export function linkedStoreAccountIdFromIdentifier(value: unknown): number | null {
  const match = /^store:(\d+)$/i.exec(String(value ?? '').trim());
  return match?.[1] ? finiteId(match[1]) : null;
}

function credentialsOf(row: CarrierIdentityAccount): Record<string, unknown> {
  return row.credentials && typeof row.credentials === 'object' && !Array.isArray(row.credentials)
    ? row.credentials
    : {};
}

function normalizedEnvironment(value: unknown): string {
  const normalized = String(value ?? 'production').trim().toLowerCase();
  return normalized === 'sandbox' ? 'sandbox' : 'production';
}

export function storeScopedCredentialsCorrelate(
  shippingProvider: unknown,
  carrierCredentials: Record<string, unknown>,
  storeCredentials: Record<string, unknown>,
): boolean {
  const provider = normalizeCarrierIdentityProvider(shippingProvider);
  if (provider === 'walmart_shipping') {
    const carrierClientId = text(carrierCredentials.clientId);
    const storeClientId = text(storeCredentials.clientId);
    if (!carrierClientId || !storeClientId || carrierClientId !== storeClientId) return false;

    const carrierPartner = text(carrierCredentials.partnerId ?? carrierCredentials.sellerId);
    const storePartner = text(storeCredentials.partnerId ?? storeCredentials.sellerId);
    return !carrierPartner || !storePartner || carrierPartner === storePartner;
  }

  if (provider === 'ebay_shipping') {
    const carrierAppId = text(carrierCredentials.appId);
    const storeAppId = text(storeCredentials.appId);
    return Boolean(
      carrierAppId &&
      storeAppId &&
      carrierAppId === storeAppId &&
      normalizedEnvironment(carrierCredentials.environment) === normalizedEnvironment(storeCredentials.environment),
    );
  }

  return false;
}

function clientIdsCorrelate(carrier: CarrierIdentityAccount, store: StoreAccountIdentity): boolean {
  const carrierClientId = finiteId(carrier.clientId);
  const storeClientId = finiteId(store.clientId);
  return carrierClientId == null || storeClientId == null || carrierClientId === storeClientId;
}

export type StoreAccountLinkResolution =
  | { ok: true; store: StoreAccountIdentity; derived: boolean }
  | { ok: false; code: 'STORE_LINK_REQUIRED' | 'STORE_LINK_MISMATCH' | 'STORE_LINK_AMBIGUOUS'; reason: string };

export function resolveStoreAccountLink(
  carrier: CarrierIdentityAccount,
  stores: readonly StoreAccountIdentity[],
): StoreAccountLinkResolution {
  const baseProvider = baseStoreProviderForShippingProvider(carrier.provider);
  if (!baseProvider) {
    return { ok: false, code: 'STORE_LINK_REQUIRED', reason: 'Provider is not store-scoped.' };
  }

  const candidates = stores.filter((store) =>
    store.active !== false &&
    normalizeCarrierIdentityProvider(store.provider) === baseProvider &&
    clientIdsCorrelate(carrier, store) &&
    storeScopedCredentialsCorrelate(carrier.provider, credentialsOf(carrier), credentialsOf(store)),
  );
  const explicitId = linkedStoreAccountIdFromIdentifier(carrier.accountIdentifier);
  if (explicitId != null) {
    const exact = candidates.find((store) => finiteId(store.id) === explicitId);
    return exact
      ? { ok: true, store: exact, derived: false }
      : {
          ok: false,
          code: 'STORE_LINK_MISMATCH',
          reason: 'The linked store account does not match this carrier provider, client, or credential identity.',
        };
  }

  if (candidates.length === 1) return { ok: true, store: candidates[0]!, derived: true };
  if (candidates.length > 1) {
    return {
      ok: false,
      code: 'STORE_LINK_AMBIGUOUS',
      reason: 'Multiple matching store accounts exist. Select the exact store connection before using this carrier.',
    };
  }
  return {
    ok: false,
    code: 'STORE_LINK_REQUIRED',
    reason: 'No exact matching store account is linked to this carrier.',
  };
}

function safeCredentialIdentifier(provider: string, credentials: Record<string, unknown>): string | null {
  for (const field of SAFE_IDENTITY_FIELDS[provider] ?? []) {
    const value = text(credentials[field]);
    if (value) return value;
  }
  return null;
}

export function safeCarrierAccountIdentifier(input: CarrierIdentityAccount & {
  linkedStore?: StoreAccountIdentity | null;
}): string {
  const provider = normalizeCarrierIdentityProvider(input.provider);
  if (input.linkedStore) {
    const storeLabel = text(input.linkedStore.label);
    return `${storeLabel ?? PROVIDER_LABELS[baseStoreProviderForShippingProvider(provider) ?? ''] ?? 'Store'} (#${input.linkedStore.id})`;
  }

  const credentials = credentialsOf(input);
  if (provider === 'shopify') {
    const domain = safeShopifyDomain(credentials.shopDomain ?? input.accountIdentifier);
    if (domain) return domain;
  }
  const safeCredential = safeCredentialIdentifier(provider, credentials);
  if (safeCredential) return safeCredential;

  return text(input.label) ?? `${PROVIDER_LABELS[provider] ?? provider.replace(/_/g, ' ')} account #${input.id}`;
}

export function safeCarrierAccountLabel(
  input: CarrierIdentityAccount,
  verifiedLabel?: unknown,
): string {
  const provider = normalizeCarrierIdentityProvider(input.provider);
  const candidate = text(verifiedLabel);
  if (candidate) {
    const containsSecret = Object.entries(credentialsOf(input)).some(([key, value]) => {
      if (!/(?:key|token|secret|password|cert|private)/i.test(key)) return false;
      const secret = text(value);
      return Boolean(secret && secret.length >= 4 && candidate.includes(secret));
    });
    if (!containsSecret) return candidate;
  }
  return text(input.label) ?? PROVIDER_LABELS[provider] ?? provider.replace(/_/g, ' ');
}

export function storedCarrierAccountIdentifier(input: {
  provider: string;
  label?: string | null;
  credentials: Record<string, unknown>;
  storeAccountId?: number | null;
}): string | null {
  if (isStoreScopedCarrierProvider(input.provider)) {
    const storeAccountId = finiteId(input.storeAccountId);
    return storeAccountId == null ? null : carrierStoreLinkIdentifier(storeAccountId);
  }
  return safeCredentialIdentifier(normalizeCarrierIdentityProvider(input.provider), input.credentials) ?? text(input.label);
}

export function toSafeCarrierAccountReadModel(
  row: CarrierIdentityAccount & Record<string, unknown>,
  stores: readonly StoreAccountIdentity[] = [],
): Record<string, unknown> {
  const link = isStoreScopedCarrierProvider(row.provider) ? resolveStoreAccountLink(row, stores) : null;
  const linkedStore = link?.ok ? link.store : null;
  const { credentials: _credentials, ...publicRow } = row;
  return {
    ...publicRow,
    label: safeCarrierAccountLabel(row),
    accountIdentifier: safeCarrierAccountIdentifier({ ...row, linkedStore }),
    displayIdentity: safeCarrierAccountIdentifier({ ...row, linkedStore }),
    linkedStoreAccountId: linkedStore?.id ?? null,
    identityStatus: link == null || link.ok ? 'verified' : 'store_link_required',
    identityBlockReason: link && !link.ok ? link.reason : null,
  };
}
