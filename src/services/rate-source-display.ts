/**
 * Canonical rate-source display classification.
 *
 * Provider/account identity is backend truth. React may choose presentation
 * colors, but it must not infer ShipStation vs direct-carrier ownership from
 * synthetic provider ids, nicknames, or separately fetched account lists.
 */

type RateSourceAccount = {
  carrier_id: string;
  nickname?: string | null;
  friendly_name?: string | null;
  source_client_id?: number | null;
  source_client_name?: string | null;
};

const DIRECT_PROVIDER_LABELS: Record<string, string> = {
  amazon_shipping: 'Amazon Shipping',
  ebay_shipping: 'eBay Shipping',
  ehub: 'eHub',
  easypost: 'EasyPost',
  fedex: 'FedEx Direct',
  gls: 'GLS Direct',
  shipp: 'Shipp',
  shipengine: 'ShipEngine',
  simulator: 'Simulator',
  stamps_com: 'Stamps.com Direct',
  ups: 'UPS Direct',
  usps: 'USPS Direct',
  walmart_shipping: 'Walmart Shipping',
};

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function providerKey(value: unknown): string | null {
  const text = cleanText(value);
  return text ? text.toLowerCase().replace(/[\s-]+/g, '_') : null;
}

function isDirectRate(rate: Record<string, unknown>): boolean {
  return rate.directCarrierAccountId != null ||
    rate.directCarrierSourceTable != null ||
    rate.direct_carrier_account_id != null ||
    rate.direct_carrier_source_table != null;
}

export function stampRateSourceDisplay(
  rate: Record<string, unknown>,
  accounts: RateSourceAccount[] = [],
): Record<string, unknown> {
  if (rate.testFixture === true || rate.mocked === true) {
    return {
      ...rate,
      rateSourceKind: 'test_fixture',
      rateSourceLabel: 'PrepShip Test',
      rateSourceDetail: cleanText(rate.carrier_nickname),
    };
  }

  if (isDirectRate(rate)) {
    const key = providerKey(rate.provider ?? rate.source ?? rate.carrier_code);
    const label = (key ? DIRECT_PROVIDER_LABELS[key] : null) ?? 'Direct Carrier';
    const nickname = cleanText(rate.carrier_nickname ?? rate.carrierNickname);
    return {
      ...rate,
      rateSourceKind: 'direct',
      rateSourceLabel: label,
      rateSourceDetail: nickname && nickname !== label ? nickname : null,
    };
  }

  const carrierId = cleanText(rate.carrier_id ?? rate.carrierId);
  const account = carrierId
    ? accounts.find((candidate) => candidate.carrier_id === carrierId) ?? null
    : null;
  const providerMatch = /^se-(\d+)$/i.exec(carrierId ?? '');
  const sourceClientId = account?.source_client_id ?? null;
  const detailParts = [
    cleanText(account?.source_client_name),
    sourceClientId != null ? `Client #${sourceClientId}` : null,
    providerMatch ? `Provider #${providerMatch[1]}` : null,
  ].filter((value): value is string => value != null);
  return {
    ...rate,
    rateSourceKind: 'shipstation',
    rateSourceLabel: 'ShipStation',
    rateSourceDetail: detailParts.length > 0 ? detailParts.join(' | ') : null,
  };
}

export function stampRateSourceDisplayList(
  rates: Array<Record<string, unknown>>,
  accounts: RateSourceAccount[] = [],
): Array<Record<string, unknown>> {
  return rates.map((rate) => stampRateSourceDisplay(rate, accounts));
}
