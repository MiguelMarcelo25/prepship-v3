import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION,
  readFrozenCustomerShippingMoney,
  type CustomerShippingMoneyPolicyVersion,
  type FrozenCustomerShippingMoney,
} from './customer-shipping-money-snapshot.js';

/**
 * PS-508 step 1 — why a snapshot is unusable, not merely THAT it is.
 *
 * ── WHY readFrozenCustomerShippingMoney IS NOT ENOUGH ────────────────────────────────────
 *
 * That reader answers one question — "may I bill from this?" — and returns null for every kind
 * of no. Absent key, unrecognised version, recognised version whose margin does not reconcile,
 * and simply-not-yet-accepted all collapse to the same null. That is correct for a biller and
 * useless for a cutover, because the four cases need OPPOSITE handling:
 *
 *   legacy_absent           -> a shipment bought before the writer existed. Recompute is the
 *                              honest answer; it can never receive a truthful label-time tuple.
 *   malformed_known_version -> a row we DID write and got wrong. Recomputing silently would
 *                              hide a writer defect behind the legacy path, and the one-shot
 *                              guard keys on key PRESENCE, so the writer will not repair it.
 *   unknown_version         -> written by a newer policy this build does not understand.
 *                              Overwriting it would destroy a fact a later version owns.
 *   valid_*                 -> billable, per its own version.
 *
 * The audit ruled the cutover unsafe while all four looked identical, and it is right: treating
 * a malformed tuple as "legacy absent" lets a systematic writer error bill as if it were normal.
 *
 * ── PURE ────────────────────────────────────────────────────────────────────────────────
 *
 * No database import, directly or transitively — customer-shipping-money-snapshot depends only
 * on roundMoney. The coverage audit, the billing precedence path and CI guards all need this,
 * and a lane without a database env must be able to run it.
 */

export type CustomerShippingMoneyClassKind =
  | 'valid_ps508'
  | 'valid_ps437'
  | 'valid_ps509'
  | 'legacy_absent'
  | 'malformed_known_version'
  | 'unknown_version';

export type CustomerShippingMoneyClassification =
  | { kind: 'valid_ps508' | 'valid_ps437' | 'valid_ps509'; frozen: FrozenCustomerShippingMoney;
      policyVersion: CustomerShippingMoneyPolicyVersion }
  | { kind: 'legacy_absent' }
  | { kind: 'malformed_known_version'; policyVersion: CustomerShippingMoneyPolicyVersion;
      reason: string }
  | { kind: 'unknown_version'; rawVersion: string };

const VERSION_KEY = 'customerShippingMoneyPolicyVersion';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `legacy_absent` means the VERSION KEY is absent — deliberately not "the jsonb is empty".
 *
 * selected_rate_json carries the provider receipt on every purchased label, so a row with a
 * receipt and no tuple is the ordinary pre-writer shape. Keying on the whole blob being empty
 * would classify every historical shipment as malformed.
 */
export function classifyCustomerShippingMoney(
  selectedRateJson: unknown,
): CustomerShippingMoneyClassification {
  const row = isRecord(selectedRateJson) ? selectedRateJson : null;
  if (!row || !Object.prototype.hasOwnProperty.call(row, VERSION_KEY)) {
    return { kind: 'legacy_absent' };
  }

  const rawVersion = row[VERSION_KEY];
  if (typeof rawVersion !== 'string') {
    return { kind: 'unknown_version', rawVersion: String(rawVersion) };
  }
  const known = (ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS as readonly string[])
    .includes(rawVersion);
  if (!known) {
    // A FUTURE version this build cannot read. Never repaired, never overwritten — the tuple
    // belongs to a policy that knows more than this code does.
    return { kind: 'unknown_version', rawVersion };
  }

  const policyVersion = rawVersion as CustomerShippingMoneyPolicyVersion;
  // Ask the canonical reader, accepting exactly the version the row claims, so validity is
  // judged by the one owner rather than re-implemented here and allowed to drift from it.
  const frozen = readFrozenCustomerShippingMoney(selectedRateJson, { accept: [policyVersion] });
  if (!frozen) {
    return { kind: 'malformed_known_version', policyVersion, reason: explainInvalid(row) };
  }
  return {
    kind: policyVersion === CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND
      ? 'valid_ps508'
      : policyVersion === CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION
        ? 'valid_ps509'
        : 'valid_ps437',
    frozen,
    policyVersion,
  };
}

/**
 * Diagnostic only — never a billing decision. The reader owns validity; this just says which
 * invariant looked wrong, so an operator reading the coverage report can tell a rounding drift
 * from a missing field without opening the row by hand.
 */
function explainInvalid(row: Record<string, unknown>): string {
  const missing = ['selectedRateCost', 'cShippingRateAmount', 'shippingMarginAmount',
    'customerRateSource', 'rateCostSource']
    .filter((key) => row[key] == null);
  if (missing.length) return `missing: ${missing.join(', ')}`;
  if (!Object.prototype.hasOwnProperty.call(row, 'shippingMarginPct')) {
    return 'missing: shippingMarginPct (absent, not null)';
  }
  const cost = Number(row.selectedRateCost);
  const customer = Number(row.cShippingRateAmount);
  const margin = Number(row.shippingMarginAmount);
  if (![cost, customer, margin].every(Number.isFinite)) return 'non-numeric money field';
  if (cost <= 0 || customer <= 0) return 'non-positive cost or customer amount';
  if (Math.abs((customer - cost) - margin) > 0.001) {
    return `margin does not reconcile: ${customer} - ${cost} != ${margin}`;
  }
  // PS-509: the dimension rules are version-conditional, so the diagnosis is too.
  if (row.customerShippingMoneyPolicyVersion === CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION) {
    if (row.rateCostSource !== 'shipstation_sync_receipt_cost') {
      return `rateCostSource: ${String(row.rateCostSource)} (ps-509-v1 requires shipstation_sync_receipt_cost)`;
    }
    if (row.customerShippingMoneyCaptureSource !== 'shipstation_sync_ingestion') {
      return `customerShippingMoneyCaptureSource: ${String(row.customerShippingMoneyCaptureSource)} `
        + '(ps-509-v1 requires shipstation_sync_ingestion)';
    }
    return `customerRateSource: ${String(row.customerRateSource)} (not a sync-ingress formula)`;
  }
  if (Object.prototype.hasOwnProperty.call(row, 'customerShippingMoneyCaptureSource')) {
    return 'customerShippingMoneyCaptureSource: present on a version that never recorded one';
  }
  if (row.rateCostSource !== 'label_final_cost') return `rateCostSource: ${String(row.rateCostSource)}`;
  return `customerRateSource: ${String(row.customerRateSource)}`;
}

/** Only genuine pre-writer absence may take the recompute fallback after cutover. */
export function mayUseLegacyRecompute(c: CustomerShippingMoneyClassification): boolean {
  return c.kind === 'legacy_absent';
}

/** Billable now, under the versions this build accepts for the given consumer. */
export function billableUnder(
  c: CustomerShippingMoneyClassification,
  accept: readonly CustomerShippingMoneyPolicyVersion[],
): FrozenCustomerShippingMoney | null {
  return (c.kind === 'valid_ps508' || c.kind === 'valid_ps437' || c.kind === 'valid_ps509')
    && accept.includes(c.policyVersion)
    ? c.frozen
    : null;
}

export { CUSTOMER_SHIPPING_MONEY_POLICY_VERSION, CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND };
