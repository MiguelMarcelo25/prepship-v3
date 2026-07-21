import {
  shippingProviderIdFromAuthorizedRate,
  shippingQuoteCredentialFingerprint,
  type ShippingQuoteAccountAuthorization,
} from './shipping-quote-authorization';

export function shipStationQuoteAccountAuthorizations(input: {
  rates: Array<Record<string, unknown>>;
  clientId: number | null;
  sourceClientId: number | null;
  apiKeyV2: string | null;
}): ShippingQuoteAccountAuthorization[] {
  const credential = input.apiKeyV2 ?? process.env.SHIPSTATION_API_KEY_V2 ?? null;
  if (!credential) return [];
  const credentialSource = input.sourceClientId == null
    ? 'application_default'
    : input.sourceClientId === input.clientId
      ? 'client'
      : 'rate_source_client';
  const providerIds = new Set(
    input.rates
      .map(shippingProviderIdFromAuthorizedRate)
      .filter((id): id is number => id != null && id < 10_000_000),
  );
  return [...providerIds].map((shippingProviderId) => ({
    providerFamily: 'shipstation',
    provider: 'shipstation',
    shippingProviderId,
    sourceTable: 'shipstation',
    sourceAccountId: shippingProviderId,
    ownerClientId: input.sourceClientId,
    ownerStoreAccountId: null,
    credentialSource,
    credentialFingerprint: shippingQuoteCredentialFingerprint(credential),
    environment: process.env.NODE_ENV ?? 'development',
  }));
}
