import { roundMoney } from '../lib/money.js';

export const CUSTOMER_SHIPPING_MONEY_POLICY_VERSION = 'ps-437-v1';

/**
 * PS-508 — the ORDINARY-OUTBOUND version. A SECOND accepted version, deliberately not a new value
 * for the constant above.
 *
 * ── WHY NOT JUST EDIT ps-437-v1 ─────────────────────────────────────────────────────────
 *
 * resolveCustomerShippingMoney stamps the version unconditionally, and the REPLACEMENT freeze
 * flows through it. Bumping the constant in place would therefore silently start writing the new
 * version on every replacement — while the Client Portal still pins the literal 'ps-437-v1' in
 * four independent runtime sites (a TS reader, a SQL gate, an HTTP-boundary validator and an audit
 * script) and does NOT import this constant. Replacement money would vanish from the portal with
 * nothing failing loudly on either side.
 *
 * Two coexisting versions is also what makes the cutover STAGEABLE: outbound tuples are invisible
 * to every consumer until that consumer explicitly opts in (see `accept` below).
 */
export const CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND = 'ps-508-v1';

/**
 * PS-509 — the ShipStation SYNC-INGRESS version, a THIRD accepted version for the same
 * staging reason ps-508-v1 was a second: a sync tuple stays invisible to every consumer
 * until that consumer names this version explicitly. It is not a flavour of ps-508-v1
 * because the two freeze at DIFFERENT moments from DIFFERENT evidence: ps-508-v1 freezes
 * inside the purchase transaction from the label's final cost; ps-509-v1 freezes at sync
 * ingestion from an authoritative-but-not-proven-final receipt, minutes after purchase
 * (measured p50 138s / p99 ~13min), with no policy-history table able to prove the
 * billing policy was stable across that gap. Collapsing them into one version would
 * destroy exactly the distinction the reader needs to validate them differently.
 */
export const CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION = 'ps-509-v1';

export const ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS = [
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_OUTBOUND,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION,
] as const;

export type CustomerShippingMoneyPolicyVersion =
  typeof ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS[number];

/**
 * PS-508: `house_next_best_customer_rate` is a THIRD provenance, not a flavour of the first.
 *
 * Billing's house path (billing-shipping-line.ts, `source: 'c_shipping_rate'`) bills the captured
 * next-best competitor rate floored at label cost, with reference-rate flooring AND carrier markup
 * fully suppressed. Before this, such a tuple would have been stamped
 * `realized_customer_shipping_rate` — byte-indistinguishable from carrier-markup money that was
 * computed by a completely different formula. Provenance, not amount, is what tells them apart;
 * PS-502 already removed an equality tripwire that tried to do this by value and could not.
 */
export type CustomerShippingRateSource =
  | 'realized_customer_shipping_rate'
  | 'hugrab_shipping_rate_override'
  | 'house_next_best_customer_rate'
  /**
   * PS-509 — the carrier-markup FORMULA applied at sync ingestion. Deliberately not
   * `realized_customer_shipping_rate`: that name is bound to money realized from a label's
   * final purchase cost inside the purchase transaction. The sync formula is the same
   * markup arithmetic applied to a sync RECEIPT — a different evidentiary basis — and
   * provenance, not amount, is what tells two formulas apart after the fact.
   */
  | 'carrier_markup_customer_shipping_rate';

/**
 * PS-509 — timing/provenance is its OWN dimension, never smuggled into the formula field.
 * `shipstation_sync_ingestion` is the honest name for when these facts were captured:
 * policy facts existed at ingestion, but no policy-history table can prove they were
 * stable across the purchase→ingestion gap, so the tuple must not claim purchase-time.
 */
export type CustomerShippingMoneyCaptureSource = 'shipstation_sync_ingestion';

/**
 * PS-509 — which observation the frozen selected cost came from. `label_final_cost` is a
 * purchase-transaction fact. `shipstation_sync_receipt_cost` is an authoritative receipt
 * observed at first sync ingestion — NOT proven immutable, because ShipStation may revise
 * cost later (the receipt_revised_after_freeze review class exists for exactly that).
 */
export type CustomerShippingRateCostSource =
  | 'label_final_cost'
  | 'shipstation_sync_receipt_cost';

export type FrozenCustomerShippingPricingAuthority = {
  policyOwner: 'billing_config';
  policyId: string;
  /** The exact billing_config.updated_at value read with the shipment. */
  policyRowVersion: string;
  policyActive: true;
  clientId: number;
  billingMode: string;
  perAccountMarkupEnabled: boolean;
  markupAuthority:
    | 'per_account_override'
    | 'client_billing_config'
    | 'explicit_zero_markup';
  markupRuleKey: string;
  markupPct: number;
  markupFlat: number;
  markupAdjustmentKind: 'customer_profit_markup' | 'true_cost_uplift';
  providerAccountId: number | null;
  selectedOverrideIdentity: {
    authority: 'settings';
    settingKey: string;
    providerAccountId: number;
    ruleType: 'amount' | 'percent';
    ruleValue: number;
    adjustmentKind: 'customer_profit_markup' | 'true_cost_uplift';
  } | null;
  appliedHugrabOverrideIdentity: {
    ruleKey: 'billing_config.hugrab_shipping_rate_override';
    threshold: number;
    amount: number;
  } | null;
  billingSource: 'c_shipping_rate' | 'reference_rate' | 'label_cost';
};

export type FrozenCustomerShippingMoney = {
  selectedRateCost: number;
  cShippingRateAmount: number;
  shippingMarginAmount: number;
  shippingMarginPct: number | null;
  customerRateSource: CustomerShippingRateSource;
  rateCostSource: CustomerShippingRateCostSource;
  customerShippingMoneyPolicyVersion: CustomerShippingMoneyPolicyVersion;
  /**
   * PS-509 — REQUIRED for ps-509-v1, and required-ABSENT on ps-437-v1/ps-508-v1.
   * Those versions never recorded a capture provenance; a historical tuple suddenly
   * carrying one is an unknown combination and must classify as malformed rather than
   * be silently normalized (the reader enforces this per version).
   */
  customerShippingMoneyCaptureSource?: CustomerShippingMoneyCaptureSource;
  /**
   * PS-508 — the EIGHTH field, and optional on purpose.
   *
   * Billing consumes exactly two outputs of resolveCustomerShippingMoney: the amount, and this
   * suffix (e.g. " (20% + $1.00)"), which it appends to the line description. Description is part
   * of the unique index that suppresses duplicate billing lines, so a freeze that captured only
   * the seven money fields could reproduce the AMOUNT but not the LINE — descriptions would drift
   * at cutover and duplicate suppression would stop matching.
   *
   * Optional rather than required because every already-frozen ps-437-v1 tuple in production was
   * written without it. Making it required would retroactively invalidate all of them: the reader
   * would return null, and money that is frozen and correct would read as absent.
   */
  billingDescriptionSuffix?: string;
  /**
   * AC-10 pricing authority. Optional for historical return tuples and PS-508's staged rollout;
   * the replacement-specific reader below requires it before a tuple can become billable.
   */
  customerShippingPricingAuthority?: FrozenCustomerShippingPricingAuthority;
};

export type FrozenReplacementCustomerShippingMoney = FrozenCustomerShippingMoney & {
  customerShippingMoneyPolicyVersion: typeof CUSTOMER_SHIPPING_MONEY_POLICY_VERSION;
  customerShippingPricingAuthority: FrozenCustomerShippingPricingAuthority;
};

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * PS-509 — the formula unions are PER VERSION, not one shared set. A purchase-path
 * tuple claiming the sync formula (or a sync tuple claiming house money, which this
 * ingress can never produce — no `shipp` carrier exists in the sync population) is an
 * unknown combination, and unknown combinations classify as malformed, never normalized.
 */
const PURCHASE_RATE_SOURCES: ReadonlySet<string> = new Set<CustomerShippingRateSource>([
  'realized_customer_shipping_rate',
  'hugrab_shipping_rate_override',
  'house_next_best_customer_rate',
]);

const MARKUP_AUTHORITIES: ReadonlySet<string> = new Set([
  'per_account_override',
  'client_billing_config',
  'explicit_zero_markup',
] as const);

const ADJUSTMENT_KINDS: ReadonlySet<string> = new Set([
  'customer_profit_markup',
  'true_cost_uplift',
] as const);

function readPricingAuthority(value: unknown): FrozenCustomerShippingPricingAuthority | null {
  const row = recordOrNull(value);
  if (!row) return null;
  const clientId = finiteNumber(row.clientId);
  const markupPct = finiteNumber(row.markupPct);
  const markupFlat = finiteNumber(row.markupFlat);
  const providerAccountId = row.providerAccountId == null
    ? null
    : finiteNumber(row.providerAccountId);
  const policyId = row.policyId;
  const policyRowVersion = row.policyRowVersion;
  const billingMode = row.billingMode;
  const markupAuthority = row.markupAuthority;
  const markupRuleKey = row.markupRuleKey;
  const markupAdjustmentKind = row.markupAdjustmentKind;
  const billingSource = row.billingSource;
  if (
    row.policyOwner !== 'billing_config' ||
    clientId == null || !Number.isInteger(clientId) || clientId <= 0 ||
    policyId !== `billing_config:${clientId}` ||
    typeof policyRowVersion !== 'string' || !policyRowVersion ||
    Number.isNaN(Date.parse(policyRowVersion)) ||
    row.policyActive !== true ||
    typeof billingMode !== 'string' || !billingMode ||
    typeof row.perAccountMarkupEnabled !== 'boolean' ||
    typeof markupAuthority !== 'string' ||
    !MARKUP_AUTHORITIES.has(markupAuthority) ||
    typeof markupRuleKey !== 'string' || !markupRuleKey ||
    markupPct == null || markupFlat == null ||
    typeof markupAdjustmentKind !== 'string' ||
    !ADJUSTMENT_KINDS.has(markupAdjustmentKind) ||
    (providerAccountId != null && (!Number.isInteger(providerAccountId) || providerAccountId <= 0)) ||
    (billingSource !== 'c_shipping_rate' &&
      billingSource !== 'reference_rate' &&
      billingSource !== 'label_cost')
  ) {
    return null;
  }

  const selectedRaw = row.selectedOverrideIdentity;
  const selected = selectedRaw == null ? null : recordOrNull(selectedRaw);
  let selectedOverrideIdentity: FrozenCustomerShippingPricingAuthority['selectedOverrideIdentity'] = null;
  if (selected) {
    const selectedProviderAccountId = finiteNumber(selected.providerAccountId);
    const ruleValue = finiteNumber(selected.ruleValue);
    if (
      selected.authority !== 'settings' ||
      typeof selected.settingKey !== 'string' || !selected.settingKey.startsWith('markup.') ||
      selectedProviderAccountId == null || !Number.isInteger(selectedProviderAccountId) ||
      selectedProviderAccountId <= 0 ||
      (selected.settingKey !== `markup.se-${selectedProviderAccountId}` &&
        selected.settingKey !== `markup.${selectedProviderAccountId}`) ||
      (selected.ruleType !== 'amount' && selected.ruleType !== 'percent') ||
      ruleValue == null || ruleValue === 0 ||
      (selected.adjustmentKind !== 'customer_profit_markup' &&
        selected.adjustmentKind !== 'true_cost_uplift')
    ) {
      return null;
    }
    selectedOverrideIdentity = {
      authority: 'settings',
      settingKey: selected.settingKey,
      providerAccountId: selectedProviderAccountId,
      ruleType: selected.ruleType,
      ruleValue,
      adjustmentKind: selected.adjustmentKind,
    };
  } else if (selectedRaw !== null) {
    return null;
  }

  if (markupAuthority === 'per_account_override') {
    if (
      row.perAccountMarkupEnabled !== true ||
      !selectedOverrideIdentity ||
      providerAccountId !== selectedOverrideIdentity.providerAccountId ||
      markupRuleKey !== selectedOverrideIdentity.settingKey ||
      markupAdjustmentKind !== selectedOverrideIdentity.adjustmentKind ||
      (selectedOverrideIdentity.ruleType === 'percent' &&
        (markupPct !== selectedOverrideIdentity.ruleValue || markupFlat !== 0)) ||
      (selectedOverrideIdentity.ruleType === 'amount' &&
        (markupPct !== 0 || markupFlat !== selectedOverrideIdentity.ruleValue))
    ) {
      return null;
    }
  } else if (
    selectedOverrideIdentity != null ||
    markupRuleKey !== 'billing_config.shipping_markup_pct+shipping_markup_flat' ||
    markupAdjustmentKind !== 'customer_profit_markup' ||
    (markupAuthority === 'explicit_zero_markup' && (markupPct !== 0 || markupFlat !== 0)) ||
    (markupAuthority === 'client_billing_config' && markupPct === 0 && markupFlat === 0)
  ) {
    return null;
  }

  const hugrabRaw = row.appliedHugrabOverrideIdentity;
  const hugrab = hugrabRaw == null ? null : recordOrNull(hugrabRaw);
  let appliedHugrabOverrideIdentity:
    FrozenCustomerShippingPricingAuthority['appliedHugrabOverrideIdentity'] = null;
  if (hugrab) {
    const threshold = finiteNumber(hugrab.threshold);
    const amount = finiteNumber(hugrab.amount);
    if (
      hugrab.ruleKey !== 'billing_config.hugrab_shipping_rate_override' ||
      threshold == null || threshold <= 0 ||
      amount == null || amount <= 0
    ) {
      return null;
    }
    appliedHugrabOverrideIdentity = {
      ruleKey: 'billing_config.hugrab_shipping_rate_override',
      threshold,
      amount,
    };
  } else if (hugrabRaw !== null) {
    return null;
  }

  return {
    policyOwner: 'billing_config',
    policyId,
    policyRowVersion,
    policyActive: true,
    clientId,
    billingMode,
    perAccountMarkupEnabled: row.perAccountMarkupEnabled,
    markupAuthority: markupAuthority as FrozenCustomerShippingPricingAuthority['markupAuthority'],
    markupRuleKey,
    markupPct,
    markupFlat,
    markupAdjustmentKind:
      markupAdjustmentKind as FrozenCustomerShippingPricingAuthority['markupAdjustmentKind'],
    providerAccountId,
    selectedOverrideIdentity,
    appliedHugrabOverrideIdentity,
    billingSource,
  };
}

const SYNC_INGESTION_RATE_SOURCES: ReadonlySet<string> = new Set<CustomerShippingRateSource>([
  'carrier_markup_customer_shipping_rate',
  'hugrab_shipping_rate_override',
]);

/**
 * Strict reader for an already-frozen shared money snapshot. Unlike the legacy
 * rate normalizer, this never manufactures customer money from selected cost.
 *
 * ── `accept` IS THE CUTOVER SWITCH ──────────────────────────────────────────────────────
 *
 * It defaults to ps-437-v1 ALONE, which is byte-for-byte today's behaviour: an ordinary-outbound
 * tuple is invisible to every existing consumer until that consumer names the outbound version.
 * That is deliberate. If this reader accepted both versions by default, every consumer would flip
 * the instant the first outbound freeze landed, and the staged rollout would not exist — the
 * migration would be one un-revertable step across billing, the portal and analytics at once.
 *
 * Widening the default is therefore a MONEY-VISIBLE change, not a cleanup.
 */
export function readFrozenCustomerShippingMoney(
  value: unknown,
  options?: { accept?: readonly CustomerShippingMoneyPolicyVersion[] },
): FrozenCustomerShippingMoney | null {
  const accept: readonly CustomerShippingMoneyPolicyVersion[] =
    options?.accept ?? [CUSTOMER_SHIPPING_MONEY_POLICY_VERSION];
  const row = recordOrNull(value);
  if (!row) return null;
  const selectedRateCost = finiteNumber(row.selectedRateCost);
  const cShippingRateAmount = finiteNumber(row.cShippingRateAmount);
  const shippingMarginAmount = finiteNumber(row.shippingMarginAmount);
  const hasShippingMarginPct = Object.prototype.hasOwnProperty.call(row, 'shippingMarginPct');
  const shippingMarginPct = row.shippingMarginPct == null
    ? null
    : finiteNumber(row.shippingMarginPct);
  const customerRateSource = row.customerRateSource;
  const rateCostSource = row.rateCostSource;
  const policyVersion = row.customerShippingMoneyPolicyVersion;
  const hasPricingAuthority = Object.prototype.hasOwnProperty.call(
    row,
    'customerShippingPricingAuthority',
  );
  const pricingAuthority = hasPricingAuthority
    ? readPricingAuthority(row.customerShippingPricingAuthority)
    : null;
  if (
    selectedRateCost == null || selectedRateCost <= 0 ||
    cShippingRateAmount == null || cShippingRateAmount <= 0 ||
    shippingMarginAmount == null ||
    !hasShippingMarginPct ||
    (row.shippingMarginPct != null && shippingMarginPct == null) ||
    Math.abs(roundMoney(cShippingRateAmount - selectedRateCost) - roundMoney(shippingMarginAmount)) > 0.001 ||
    typeof customerRateSource !== 'string' ||
    typeof policyVersion !== 'string' ||
    !accept.includes(policyVersion as CustomerShippingMoneyPolicyVersion) ||
    (hasPricingAuthority && !pricingAuthority) ||
    (hasPricingAuthority &&
      (customerRateSource === 'hugrab_shipping_rate_override') !==
        (pricingAuthority?.appliedHugrabOverrideIdentity != null))
  ) {
    return null;
  }

  // PS-509 — validity is CONDITIONAL ON VERSION. ps-437-v1 keeps its historical
  // optionality and ps-508-v1 keeps the purchase-path contract exactly as before:
  // label-final cost basis, purchase formulas, and NO capture-source key (those
  // versions never recorded one, so a tuple suddenly carrying it is an unknown
  // combination — malformed, never silently normalized). ps-509-v1 REQUIRES the
  // sync receipt-cost basis and the shipstation_sync_ingestion capture source, and
  // admits only the formulas this ingress can actually produce (house is never).
  const isSyncIngestion = policyVersion === CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION;
  const captureSourcePresent =
    Object.prototype.hasOwnProperty.call(row, 'customerShippingMoneyCaptureSource');
  if (isSyncIngestion) {
    if (
      rateCostSource !== 'shipstation_sync_receipt_cost' ||
      row.customerShippingMoneyCaptureSource !== 'shipstation_sync_ingestion' ||
      !SYNC_INGESTION_RATE_SOURCES.has(customerRateSource)
    ) {
      return null;
    }
  } else if (
    rateCostSource !== 'label_final_cost' ||
    captureSourcePresent ||
    !PURCHASE_RATE_SOURCES.has(customerRateSource)
  ) {
    return null;
  }
  return {
    selectedRateCost: roundMoney(selectedRateCost),
    cShippingRateAmount: roundMoney(cShippingRateAmount),
    shippingMarginAmount: roundMoney(shippingMarginAmount),
    shippingMarginPct,
    customerRateSource: customerRateSource as CustomerShippingRateSource,
    // Version-validated above: label_final_cost for the purchase versions,
    // shipstation_sync_receipt_cost for ps-509-v1.
    rateCostSource: rateCostSource as CustomerShippingRateCostSource,
    // PS-509: present exactly when the version REQUIRES it, so a v437/v508 tuple
    // round-trips without gaining a capture provenance it never recorded.
    ...(isSyncIngestion
      ? { customerShippingMoneyCaptureSource: 'shipstation_sync_ingestion' as const }
      : {}),
    // PS-508: carried through only when the frozen tuple actually has it, so a v1 tuple round-trips
    // to exactly the seven fields it was written with rather than gaining an empty-string eighth
    // that would read as "no markup suffix" when the truth is "this version never recorded one".
    ...(typeof row.billingDescriptionSuffix === 'string'
      ? { billingDescriptionSuffix: row.billingDescriptionSuffix }
      : {}),
    ...(pricingAuthority
      ? { customerShippingPricingAuthority: pricingAuthority }
      : {}),
    // PS-508: return the version that was READ, never the constant.
    //
    // This line used to hardcode CUSTOMER_SHIPPING_MONEY_POLICY_VERSION. That was invisible while
    // exactly one version was accepted — the guard above had already proven they were equal. The
    // moment a SECOND version becomes acceptable it silently relabels: a ps-508-v1 tuple would be
    // handed back to the caller stamped ps-437-v1, so no consumer could tell which policy produced
    // the number it is about to bill, and the staged rollout above would be undone by its own reader.
    customerShippingMoneyPolicyVersion: policyVersion as CustomerShippingMoneyPolicyVersion,
  };
}

/** Replacement billing accepts only a tuple carrying exact active pricing authority. */
export function readFrozenReplacementCustomerShippingMoney(
  value: unknown,
): FrozenReplacementCustomerShippingMoney | null {
  const frozen = readFrozenCustomerShippingMoney(value);
  if (
    !frozen ||
    frozen.customerShippingMoneyPolicyVersion !== CUSTOMER_SHIPPING_MONEY_POLICY_VERSION ||
    !frozen.customerShippingPricingAuthority
  ) {
    return null;
  }
  return frozen as FrozenReplacementCustomerShippingMoney;
}
