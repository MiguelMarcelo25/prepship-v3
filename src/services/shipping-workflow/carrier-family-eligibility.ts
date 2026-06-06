// PS-106 — Direct-store vs ShipStation carrier-family eligibility (PRIMITIVE).
//
// Per user override unlock shipped data on 2026-06-06: this is the no-enforcement
// PRIMITIVE/setup phase. It introduces one canonical decision function plus
// best-effort classifiers. It is NOT wired into any rate/label/purchase path yet,
// so it changes ZERO runtime behavior. Enforcement (rate listing, /rates/browse,
// best rate, create label, print queue) + the Settings toggle are later slices.
//
// Business rule: ShipStation carrier accounts may only be used when the order/store
// is ShipStation-sourced. Direct-store orders (direct Walmart/eBay/store connectors)
// must not use ShipStation carriers. ShipStation credentials / rateSourceClientId
// alone do NOT make ShipStation carriers eligible for a direct-store order.
//
// SAFETY: the decision is PURE over normalized enums so it is exhaustively testable.
// The risky part — classifying an order as ShipStation-sourced vs direct-store — is a
// separate best-effort classifier the enforcement slice must wire with care (and is
// why the rollout supports an `audit_only` mode that reports-but-does-not-block).

export type CarrierFamily = 'shipstation' | 'direct' | 'unknown';
export type OrderSource = 'shipstation' | 'direct_store' | 'manual_unknown';
export type CarrierEligibilityMode = 'enforce' | 'audit_only' | 'disabled';

export const SHIPSTATION_DIRECT_STORE_RULE_ID = 'shipstation_carrier_blocked_for_direct_store_order';
export const SHIPSTATION_UNKNOWN_SOURCE_RULE_ID = 'shipstation_carrier_blocked_for_unknown_source';

export const CARRIER_ELIGIBILITY_BLOCK_MESSAGE =
  'This ShipStation carrier is not allowed for a direct-store order. Use an assigned direct carrier, or re-rate with an eligible account.';

export type CarrierEligibilityResult = {
  /** Whether the carrier family may be used (respecting the policy mode). */
  allowed: boolean;
  /** True when the rule WOULD block under enforce — surfaced even in audit_only/disabled. */
  wouldBlock: boolean;
  mode: CarrierEligibilityMode;
  ruleId?: string;
  reason?: string;
};

/**
 * Canonical, PURE decision. Direct carriers are always allowed (native/assigned).
 * ShipStation carriers are allowed only for ShipStation-sourced orders; direct-store
 * and unknown/manual sources WOULD block. The policy mode governs whether a would-block
 * actually blocks (`enforce`), only reports (`audit_only`), or is ignored (`disabled`).
 */
export function evaluateCarrierFamilyEligibility(input: {
  orderSource: OrderSource;
  carrierFamily: CarrierFamily;
  mode: CarrierEligibilityMode;
}): CarrierEligibilityResult {
  const { orderSource, carrierFamily, mode } = input;

  // Direct/native carriers and unknown-family (no ShipStation postage) never blocked here.
  if (carrierFamily !== 'shipstation') {
    return { allowed: true, wouldBlock: false, mode };
  }

  // ShipStation carrier: eligible only for ShipStation-sourced orders.
  let wouldBlock = false;
  let ruleId: string | undefined;
  let reason: string | undefined;
  if (orderSource === 'direct_store') {
    wouldBlock = true;
    ruleId = SHIPSTATION_DIRECT_STORE_RULE_ID;
    reason = CARRIER_ELIGIBILITY_BLOCK_MESSAGE;
  } else if (orderSource === 'manual_unknown') {
    // Documented safe default: an unknown/manual source cannot prove ShipStation
    // sourcing, so a ShipStation carrier would block under enforce.
    wouldBlock = true;
    ruleId = SHIPSTATION_UNKNOWN_SOURCE_RULE_ID;
    reason = CARRIER_ELIGIBILITY_BLOCK_MESSAGE;
  }

  const allowed = mode === 'enforce' ? !wouldBlock : true;
  return { allowed, wouldBlock, mode, ...(wouldBlock ? { ruleId, reason } : {}) };
}

// ── Best-effort classifiers (enforcement slice must validate against the connector model) ──

function text(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Classify a carrier into a family. EasyPost/Shipp/Walmart-direct = 'direct'; ShipStation/stamps = 'shipstation'. */
export function classifyCarrierFamily(carrier: {
  kind?: string | null;
  provider?: string | null;
  carrierCode?: string | null;
  isShipStation?: boolean | null;
} | null | undefined): CarrierFamily {
  if (!carrier) return 'unknown';
  if (carrier.isShipStation === true) return 'shipstation';
  const provider = text(carrier.provider);
  const code = text(carrier.carrierCode);
  const kind = text(carrier.kind);
  if (kind === 'carrier' || provider.includes('easypost') || provider.includes('shipp') || code.startsWith('shipp')) {
    return 'direct';
  }
  if (provider.includes('shipstation') || code === 'stamps_com' || code.startsWith('stamps') || code.startsWith('se-')) {
    return 'shipstation';
  }
  return 'unknown';
}

/**
 * Best-effort order-source classification. Returns 'shipstation' only when the order
 * is connected via a ShipStation store connector; 'direct_store' for direct
 * Walmart/eBay/store connectors; 'manual_unknown' otherwise. The enforcement slice
 * MUST confirm this against store_accounts/connector kind — ShipStation credentials or
 * rateSourceClientId alone are NOT proof of ShipStation sourcing.
 */
export function classifyOrderSource(order: {
  sourceConnectorKind?: string | null; // authoritative when present: 'shipstation' | 'direct'
  sourceProvider?: string | null;
  rawSource?: string | null;
} | null | undefined): OrderSource {
  if (!order) return 'manual_unknown';
  const connector = text(order.sourceConnectorKind);
  if (connector === 'shipstation') return 'shipstation';
  if (connector === 'direct' || connector === 'direct_store') return 'direct_store';
  const provider = text(order.sourceProvider) || text(order.rawSource);
  if (provider === 'shipstation') return 'shipstation';
  if (['walmart', 'ebay', 'amazon', 'shopify', 'etsy'].some((p) => provider.includes(p))) return 'direct_store';
  return 'manual_unknown';
}
