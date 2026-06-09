// PS-132 (old PS-138): single backend registry for known ShipStation carrier accounts.
//
// Before this, the same provider-id → {carrier_code, nickname, account#} table was hardcoded
// in at least 4 places (src/services/rates.ts, src/routes/orders.ts, and two frontend copies)
// and had DRIFTED: provider 433543 was "Chase x7439" in rates.ts but "UPS by SS - Chase
// x7439" everywhere else. This module is the ONE backend source; rates.ts and orders.ts now
// derive their lookup structures from it, so the rate-carrier display and the orders/billing
// account display can never disagree again.
//
// RECONCILIATION (PS-132): provider 433543 is canonicalized to "UPS by SS - Chase x7439"
// (the value used by Orders, the Settings account list, and the frontend — 3 of 4 sources).
// If the operator-facing label should be the shorter "Chase x7439", change it HERE only.
//
// This is the verified STOPGAP table. A future slice can layer a DB-backed resolver over the
// credential/account tables on top of this (DB wins, this is the fallback) without changing
// any consumer — they call the resolvers below.

export type KnownCarrierAccount = {
  shippingProviderId: number;
  carrierCode: string;
  nickname: string;
  clientId: number | null;
  accountNumber: string | null;
};

export const KNOWN_CARRIER_ACCOUNTS: KnownCarrierAccount[] = [
  { shippingProviderId: 433542, carrierCode: 'stamps_com', nickname: 'USPS Chase x7439', clientId: null, accountNumber: 'djeon-952w77' },
  // PS-132 reconciled (was "Chase x7439" in rates.ts):
  { shippingProviderId: 433543, carrierCode: 'ups_walleted', nickname: 'UPS by SS - Chase x7439', clientId: null, accountNumber: 'ups_433543' },
  { shippingProviderId: 565326, carrierCode: 'ups', nickname: 'GG6381', clientId: null, accountNumber: 'GG6381' },
  { shippingProviderId: 565377, carrierCode: 'ups', nickname: 'G19Y32', clientId: null, accountNumber: 'G19Y32' },
  { shippingProviderId: 596001, carrierCode: 'ups', nickname: 'ORION', clientId: null, accountNumber: 'R05H19' },
  { shippingProviderId: 604209, carrierCode: 'ups', nickname: 'ROCEL', clientId: null, accountNumber: null },
  { shippingProviderId: 607855, carrierCode: 'ups', nickname: 'ROCEL C81F70', clientId: null, accountNumber: 'C81F70' },
  { shippingProviderId: 598840, carrierCode: 'fedex', nickname: 'FedEx', clientId: null, accountNumber: '208481048' },
  { shippingProviderId: 585004, carrierCode: 'fedex_walleted', nickname: 'FedEx One Balance', clientId: null, accountNumber: null },
  { shippingProviderId: 442006, carrierCode: 'stamps_com', nickname: 'GREG PAYABILITY 6/17', clientId: 10, accountNumber: null },
  { shippingProviderId: 461890, carrierCode: 'ups', nickname: 'ROCEL C81F70', clientId: 10, accountNumber: 'C81F70' },
  { shippingProviderId: 565317, carrierCode: 'ups', nickname: 'GG6381', clientId: 10, accountNumber: 'GG6381' },
  { shippingProviderId: 595995, carrierCode: 'ups', nickname: 'ORI Account', clientId: 10, accountNumber: 'R05H19' },
  { shippingProviderId: 442007, carrierCode: 'ups', nickname: 'GREG PAYABILITY 6/17', clientId: 10, accountNumber: null },
  { shippingProviderId: 442013, carrierCode: 'fedex', nickname: 'FedEx', clientId: 10, accountNumber: '208481048' },
  { shippingProviderId: 585334, carrierCode: 'fedex_walleted', nickname: 'FedEx One Balance', clientId: 10, accountNumber: null },
];

/** ShipStation carrier id form used across the rate engine: `se-<providerId>`. */
export function carrierIdForProvider(shippingProviderId: number): string {
  return `se-${shippingProviderId}`;
}

const byProviderId = new Map<number, KnownCarrierAccount>(
  KNOWN_CARRIER_ACCOUNTS.map((account) => [account.shippingProviderId, account]),
);

function normalizeProviderId(idOrCarrierId: string | number): number | null {
  const raw = String(idOrCarrierId).trim();
  const match = raw.match(/^se-(\d+)$/i);
  if (match?.[1]) return Number(match[1]);
  const num = Number(raw);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

/** Resolve a known account by provider id (433543) or carrier id ('se-433543'). */
export function resolveKnownCarrierAccount(idOrCarrierId: string | number): KnownCarrierAccount | null {
  const providerId = normalizeProviderId(idOrCarrierId);
  return providerId != null ? byProviderId.get(providerId) ?? null : null;
}

export function knownCarrierNickname(idOrCarrierId: string | number): string | null {
  return resolveKnownCarrierAccount(idOrCarrierId)?.nickname ?? null;
}

export function knownCarrierCode(idOrCarrierId: string | number): string | null {
  return resolveKnownCarrierAccount(idOrCarrierId)?.carrierCode ?? null;
}
