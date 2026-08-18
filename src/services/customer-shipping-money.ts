import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shipments } from '../db/schema/shipments.js';
import { roundMoney } from '../lib/money.js';
import {
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT,
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD,
  type HugrabShippingRateOverrideConfig,
} from './billing-hugrab-shipping-rate-override.js';
import {
  decideShippingLineBilling,
  type ShippingLineBillingResult,
} from './billing-shipping-line.js';
import { loadCarrierMarkups, SS_BASELINE_CARRIER_CODES } from './rates.js';
import { resolveCanonicalMarkup } from './shipping-workflow/markup-resolver.js';
import { resolvePerAccountMarkupRule } from './shipping-workflow/per-account-markup-key.js';
import type { RateAdjustmentKind } from './shipping-workflow/rate-money.js';
import {
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  readFrozenCustomerShippingMoney,
  type FrozenCustomerShippingMoney,
} from './customer-shipping-money-snapshot.js';

export {
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
  readFrozenCustomerShippingMoney,
  type FrozenCustomerShippingMoney,
} from './customer-shipping-money-snapshot.js';

export type CustomerShippingMoneyDecision = FrozenCustomerShippingMoney & {
  billingSource: ShippingLineBillingResult['source'];
  billingDescriptionSuffix: string;
  markupApplied: boolean;
};

export type CustomerShippingMoneyInput = {
  selectedRateCost: number;
  /** Existing captured customer amount (for outbound house/frozen billing paths). */
  cShippingRateAmount?: number | null;
  billingMode?: string | null;
  carrierCode?: string | null;
  refUspsRate?: number | null;
  refUpsRate?: number | null;
  shippingMarkupPct?: number | null;
  shippingMarkupFlat?: number | null;
  shippingMarkupKind?: RateAdjustmentKind | null;
  hugrabShippingRateOverride?: HugrabShippingRateOverrideConfig | null;
};

type CustomerShippingMoneyRow = {
  shipmentId: number;
  orderId: number | null;
  clientId: number | null;
  storeIds: number[] | null;
  isReturn: boolean;
  voided: boolean;
  selectedRateCost: string | number | null;
  selectedRateJson: unknown;
  carrierCode: string | null;
  providerAccountId: number | null;
  billingMode: string | null;
  billingActive: boolean;
  shippingMarkupPct: string | number | null;
  shippingMarkupFlat: string | number | null;
  refUspsRate: string | number | null;
  refUpsRate: string | number | null;
  hugrabOverrideEnabled: boolean;
  hugrabOverrideThreshold: string | number | null;
  hugrabOverrideAmount: string | number | null;
};

export type ReturnCustomerShippingMoneyPreviewInput = {
  sourceShipmentId: number;
  selectedRateCost: number;
  carrierCode?: string | null;
  providerAccountId?: number | null;
};

export class ReturnCustomerShippingPolicyUnavailableError extends Error {
  constructor() {
    super('Customer return shipping rate is not configured');
    this.name = 'ReturnCustomerShippingPolicyUnavailableError';
  }
}

export type ReturnCustomerShippingPolicyFacts = {
  hugrabOverrideEnabled: boolean;
  billingMode: string | null;
  carrierCode: string | null;
  refUspsRate: number | null;
  refUpsRate: number | null;
  hasResolvedMarkup: boolean;
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

function roundPercent(value: number): number {
  return Math.round(value * 1000) / 10;
}

/** Fail-closed policy gate for customer-visible return postage. */
export function assertReturnCustomerShippingPolicyConfigured(
  facts: ReturnCustomerShippingPolicyFacts,
): void {
  // Per user override unlock shipped data on 2026-07-23: PS-437 uses the
  // persisted client-id billing configuration, never a mutable display name.
  const hasHugrabPolicy = facts.hugrabOverrideEnabled;
  const billingMode = facts.billingMode ?? 'per_shipment';
  const hasReferenceRatePolicy =
    (billingMode === 'reference_rate' || billingMode === 'ss_ref_rate') &&
    !SS_BASELINE_CARRIER_CODES.has(facts.carrierCode ?? '') &&
    [facts.refUspsRate, facts.refUpsRate].some((value) => value != null && value > 0);

  if (!hasHugrabPolicy && !facts.hasResolvedMarkup && !hasReferenceRatePolicy) {
    throw new ReturnCustomerShippingPolicyUnavailableError();
  }
}

/** Canonical PrepShip policy shared by outbound Billing and return snapshot freeze. */
export function resolveCustomerShippingMoney(
  input: CustomerShippingMoneyInput,
): CustomerShippingMoneyDecision {
  const selectedRateCost = finiteNumber(input.selectedRateCost);
  if (selectedRateCost == null || selectedRateCost <= 0) {
    throw new Error('Selected/purchased label cost is required to resolve customer shipping money');
  }
  const selected = roundMoney(selectedRateCost);
  const decision = decideShippingLineBilling({
    labelCost: selected,
    cShippingRateAmount: finiteNumber(input.cShippingRateAmount),
    billingMode: input.billingMode,
    isBaselineCarrier: SS_BASELINE_CARRIER_CODES.has(input.carrierCode ?? ''),
    refUspsRate: finiteNumber(input.refUspsRate) ?? 0,
    refUpsRate: finiteNumber(input.refUpsRate) ?? 0,
    shippingMarkupPct: finiteNumber(input.shippingMarkupPct) ?? 0,
    shippingMarkupFlat: finiteNumber(input.shippingMarkupFlat) ?? 0,
    shippingMarkupKind: input.shippingMarkupKind ?? 'customer_profit_markup',
    hugrabShippingRateOverride: {
      selectedRateCost: selected,
      config: input.hugrabShippingRateOverride,
    },
  });
  const customer = roundMoney(decision.billedAmount);
  const margin = roundMoney(customer - selected);
  return {
    selectedRateCost: selected,
    cShippingRateAmount: customer,
    shippingMarginAmount: margin,
    shippingMarginPct: Math.abs(margin) >= 0.005 && customer > 0
      ? roundPercent(margin / customer)
      : null,
    customerRateSource: decision.hugrabOverrideApplied
      ? 'hugrab_shipping_rate_override'
      : 'realized_customer_shipping_rate',
    rateCostSource: 'label_final_cost',
    customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION,
    billingSource: decision.source,
    billingDescriptionSuffix: decision.descriptionSuffix,
    markupApplied: decision.markupApplied,
  };
}

async function loadCustomerShippingMoneyRow(
  shipmentId: number,
  /** PS-502: so a freeze can read the row inside the transaction that is about to write it. */
  exec: Pick<typeof db, 'execute'> = db,
): Promise<CustomerShippingMoneyRow | null> {
  const rows = await exec.execute<CustomerShippingMoneyRow>(sql`
    select
      s.id as "shipmentId",
      s.order_id as "orderId",
      coalesce(s.client_id, o.client_id, store_client.id) as "clientId",
      c.store_ids as "storeIds",
      coalesce(s.is_return, false) as "isReturn",
      coalesce(s.voided, false) as voided,
      s.selected_rate_cost as "selectedRateCost",
      s.selected_rate_json as "selectedRateJson",
      s.carrier_code as "carrierCode",
      s.provider_account_id as "providerAccountId",
      coalesce(b.billing_mode, 'per_shipment') as "billingMode",
      coalesce(b.active, true) as "billingActive",
      coalesce(b.shipping_markup_pct, 0::numeric) as "shippingMarkupPct",
      coalesce(b.shipping_markup_flat, 0::numeric) as "shippingMarkupFlat",
      oo.ref_usps_rate as "refUspsRate",
      oo.ref_ups_rate as "refUpsRate",
      coalesce(b.hugrab_shipping_rate_override_enabled, false) as "hugrabOverrideEnabled",
      coalesce(
        b.hugrab_shipping_rate_override_threshold,
        ${DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD}::numeric
      ) as "hugrabOverrideThreshold",
      coalesce(
        b.hugrab_shipping_rate_override_amount,
        ${DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT}::numeric
      ) as "hugrabOverrideAmount"
    from shipments s
    left join orders o on o.id = s.order_id
    left join lateral (
      select scoped_client.id
      from clients scoped_client
      where o.store_id = any(scoped_client.store_ids)
      order by scoped_client.id
      limit 1
    ) store_client on true
    left join clients c on c.id = coalesce(s.client_id, o.client_id, store_client.id)
    left join billing_config b on b.client_id = c.id
    left join order_overrides oo on oo.order_id = o.id
    where s.id = ${shipmentId}
    limit 1
  `);
  // Shape-tolerant on purpose. drizzle over postgres-js hands back a bare array; over an
  // embedded PGlite connection it hands back `{ rows }`. Indexing [0] blindly made this loader
  // return null for EVERY row when handed a harness transaction — and a null row is
  // indistinguishable from "no such shipment", so the replacement freeze reported the shipment
  // missing rather than the reader being wrong about the envelope.
  const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? [])) as
    CustomerShippingMoneyRow[];
  return list[0] ?? null;
}

export async function getShipmentCustomerShippingMoneyTarget(
  shipmentId: number,
): Promise<{ shipmentId: number; clientId: number; storeIds: number[]; isReturn: boolean } | null> {
  const row = await loadCustomerShippingMoneyRow(shipmentId);
  if (!row || row.clientId == null) return null;
  return {
    shipmentId: row.shipmentId,
    clientId: row.clientId,
    storeIds: row.storeIds ?? [],
    isReturn: row.isReturn,
  };
}

async function decideCustomerShippingMoneyForRow(
  row: CustomerShippingMoneyRow,
  options: {
    requireExplicitReturnPolicy?: boolean;
    selectedRateCost?: number;
    carrierCode?: string | null;
    providerAccountId?: number | null;
  } = {},
): Promise<CustomerShippingMoneyDecision> {
  if (!row.billingActive) {
    if (options.requireExplicitReturnPolicy) {
      throw new ReturnCustomerShippingPolicyUnavailableError();
    }
    throw new Error('Customer shipping policy is inactive');
  }
  if (row.clientId == null) throw new Error('Customer shipping policy client is unavailable');
  // PS-437 fail-closed boundary: new return freezes require the exact provider
  // total persisted in selected_rate_cost. Legacy component fallbacks are audit
  // evidence only and must never become a newly frozen customer-money fact.
  const selectedRateCost = finiteNumber(options.selectedRateCost ?? row.selectedRateCost);
  if (selectedRateCost == null || selectedRateCost <= 0) {
    throw new Error('Selected/purchased label cost is unavailable');
  }
  const carrierCode = options.carrierCode !== undefined
    ? options.carrierCode
    : row.carrierCode;
  const providerAccountId = options.providerAccountId !== undefined
    ? options.providerAccountId
    : row.providerAccountId;
  const perAccountMarkups = process.env.BILLING_PER_ACCOUNT_MARKUP === 'on'
    ? await loadCarrierMarkups()
    : null;
  const resolvedMarkup = resolveCanonicalMarkup({
    carrierAccountMarkup: perAccountMarkups
      ? resolvePerAccountMarkupRule(perAccountMarkups, providerAccountId)
      : null,
    clientShippingMarkupPct: finiteNumber(row.shippingMarkupPct) ?? 0,
    clientShippingMarkupFlat: finiteNumber(row.shippingMarkupFlat) ?? 0,
  });
  if (options.requireExplicitReturnPolicy) {
    // PS-435: a missing/all-zero billing row is not customer-rate policy.
    // Never let the generic label-cost fallback become a customer return rate.
    assertReturnCustomerShippingPolicyConfigured({
      hugrabOverrideEnabled: row.hugrabOverrideEnabled,
      billingMode: row.billingMode,
      carrierCode,
      refUspsRate: finiteNumber(row.refUspsRate),
      refUpsRate: finiteNumber(row.refUpsRate),
      hasResolvedMarkup: resolvedMarkup != null,
    });
  }
  const decision = resolveCustomerShippingMoney({
    selectedRateCost,
    billingMode: row.billingMode,
    carrierCode,
    refUspsRate: finiteNumber(row.refUspsRate),
    refUpsRate: finiteNumber(row.refUpsRate),
    shippingMarkupPct: resolvedMarkup?.pct ?? 0,
    shippingMarkupFlat: resolvedMarkup?.flat ?? 0,
    shippingMarkupKind: resolvedMarkup?.adjustmentKind ?? 'customer_profit_markup',
    hugrabShippingRateOverride: {
      enabled: row.hugrabOverrideEnabled,
      threshold: row.hugrabOverrideThreshold,
      amount: row.hugrabOverrideAmount,
    },
  });
  if (
    options.requireExplicitReturnPolicy &&
    Math.abs(decision.cShippingRateAmount - decision.selectedRateCost) < 0.005
  ) {
    throw new ReturnCustomerShippingPolicyUnavailableError();
  }
  return decision;
}

export async function previewShipmentCustomerShippingMoney(
  shipmentId: number,
): Promise<CustomerShippingMoneyDecision> {
  const row = await loadCustomerShippingMoneyRow(shipmentId);
  if (!row) throw new Error('Shipment not found');
  return decideCustomerShippingMoneyForRow(row);
}

/**
 * Read-only reconciliation preview for a historical shipment whose exact
 * provider-selected cost exists outside selected_rate_cost. The caller must
 * supply evidence; the canonical policy owner still resolves every customer
 * amount and margin field.
 */
export async function previewShipmentCustomerShippingMoneyWithSelectedRateCost(
  shipmentId: number,
  selectedRateCost: number,
): Promise<CustomerShippingMoneyDecision> {
  const row = await loadCustomerShippingMoneyRow(shipmentId);
  if (!row) throw new Error('Shipment not found');
  return decideCustomerShippingMoneyForRow({ ...row, selectedRateCost });
}

/**
 * Read-only pre-purchase decision for Client Portal returns. The candidate
 * provider cost stays server-to-server; callers receive only customer-safe
 * amount/provenance fields from the route DTO.
 */
export async function previewReturnCustomerShippingMoney(
  input: ReturnCustomerShippingMoneyPreviewInput,
): Promise<CustomerShippingMoneyDecision> {
  const row = await loadCustomerShippingMoneyRow(input.sourceShipmentId);
  if (!row || row.isReturn || row.voided) throw new Error('Active outbound shipment not found');
  return decideCustomerShippingMoneyForRow(row, {
    requireExplicitReturnPolicy: true,
    selectedRateCost: input.selectedRateCost,
    carrierCode: input.carrierCode,
    providerAccountId: input.providerAccountId,
  });
}

/**
 * Freeze the canonical return money tuple on shipments.selected_rate_json.
 * Per user override unlock shipped data on 2026-07-22: PS-435/437 update only the
 * one explicitly requested return shipment, never status/history/postage, and
 * never rewrites a snapshot once the full policy-versioned tuple exists.
 */
/**
 * PS-502 AC-10 — freeze the CUSTOMER money for a replacement shipment.
 *
 * ── WHY THE RETURN FREEZE COULD NOT BE REUSED ───────────────────────────────────────────
 *
 * freezeReturnCustomerShippingMoney is double-gated on `isReturn = true`, in the guard and in
 * the UPDATE predicate. A replacement ships OUTBOUND, so it fails both. Reusing it would have
 * meant relaxing a return-only fence to admit something that is not a return — which is how a
 * reader asking "is this a return?" starts getting the wrong answer.
 *
 * ── WHY NOT requireExplicitReturnPolicy ─────────────────────────────────────────────────
 *
 * That option exists because a RETURN rate must be configured deliberately; a return has no
 * ordinary outbound markup to fall back on. A replacement does — it is an outbound shipment,
 * and the client's ordinary shipping markup is exactly the right policy for it. Demanding a
 * separately configured rate would make every replacement unbillable until someone set a
 * second number that means the same thing.
 *
 * ── WHAT THIS CLOSES ────────────────────────────────────────────────────────────────────
 *
 * Until now nothing produced the tuple the AC-10 fence accepts. The purchase path wrote the
 * provider receipt into shipments.cost / other_cost / selected_rate_cost and a comment called
 * it "the frozen CUSTOMER money tuple" — it was carrier cost. So a billable replacement could
 * not be billed at all: the planner refused, correctly, forever.
 *
 * The tuple is written into selected_rate_json under the same one-shot jsonb guard the return
 * freeze uses, so a retry returns the existing snapshot rather than re-deciding. Money frozen
 * once must not move because a markup changed afterwards.
 */
export async function freezeReplacementCustomerShippingMoney(
  shipmentId: number,
  /**
   * The transaction that just wrote the carrier receipt. Passing it matters: the tuple must
   * become true in the same commit as the label, or a crash between them leaves a shipment
   * whose cost says one thing and whose customer money says nothing.
   */
  exec: Pick<typeof db, 'execute' | 'update' | 'select'> = db,
): Promise<FrozenCustomerShippingMoney> {
  const row = await loadCustomerShippingMoneyRow(shipmentId, exec);
  if (!row || row.isReturn || row.voided) {
    throw new Error('Active outbound replacement shipment not found');
  }
  const existing = readFrozenCustomerShippingMoney(row.selectedRateJson);
  if (existing) return existing;

  const decision = await decideCustomerShippingMoneyForRow(row);
  const original = recordOrNull(row.selectedRateJson) ?? {};
  const frozen: FrozenCustomerShippingMoney = {
    selectedRateCost: decision.selectedRateCost,
    cShippingRateAmount: decision.cShippingRateAmount,
    shippingMarginAmount: decision.shippingMarginAmount,
    shippingMarginPct: decision.shippingMarginPct,
    customerRateSource: decision.customerRateSource,
    rateCostSource: decision.rateCostSource,
    customerShippingMoneyPolicyVersion: decision.customerShippingMoneyPolicyVersion,
  };

  const [updated] = await exec
    .update(shipments)
    .set({
      selectedRateCost: frozen.selectedRateCost.toFixed(2),
      selectedRateJson: { ...original, ...frozen },
      updatedAt: new Date(),
    })
    .where(and(
      eq(shipments.id, shipmentId),
      eq(shipments.isReturn, false),
      eq(shipments.voided, false),
      sql`not (coalesce(${shipments.selectedRateJson}, '{}'::jsonb) ? 'customerShippingMoneyPolicyVersion')`,
    ))
    .returning({ selectedRateJson: shipments.selectedRateJson });
  const winner = readFrozenCustomerShippingMoney(updated?.selectedRateJson);
  if (winner) return winner;

  // Lost the one-shot race: somebody else froze it first, and their snapshot is the truth.
  const [concurrent] = await exec
    .select({ selectedRateJson: shipments.selectedRateJson })
    .from(shipments)
    .where(eq(shipments.id, shipmentId))
    .limit(1);
  const concurrentSnapshot = readFrozenCustomerShippingMoney(concurrent?.selectedRateJson);
  if (!concurrentSnapshot) {
    throw new Error('Replacement customer shipping money snapshot could not be frozen');
  }
  return concurrentSnapshot;
}

export async function freezeReturnCustomerShippingMoney(
  shipmentId: number,
): Promise<FrozenCustomerShippingMoney> {
  const row = await loadCustomerShippingMoneyRow(shipmentId);
  if (!row || !row.isReturn || row.voided) throw new Error('Active return shipment not found');
  const existing = readFrozenCustomerShippingMoney(row.selectedRateJson);
  if (existing) return existing;

  // Per user override unlock shipped data on 2026-07-22: PS-435 tightens this
  // existing return-only freeze; shipped/cancelled edit protections stay intact.
  const decision = await decideCustomerShippingMoneyForRow(row, {
    requireExplicitReturnPolicy: true,
  });
  const original = recordOrNull(row.selectedRateJson) ?? {};
  const frozen: FrozenCustomerShippingMoney = {
    selectedRateCost: decision.selectedRateCost,
    cShippingRateAmount: decision.cShippingRateAmount,
    shippingMarginAmount: decision.shippingMarginAmount,
    shippingMarginPct: decision.shippingMarginPct,
    customerRateSource: decision.customerRateSource,
    rateCostSource: decision.rateCostSource,
    customerShippingMoneyPolicyVersion: decision.customerShippingMoneyPolicyVersion,
  };
  const [updated] = await db
    .update(shipments)
    .set({
      selectedRateCost: frozen.selectedRateCost.toFixed(2),
      selectedRateJson: { ...original, ...frozen },
      updatedAt: new Date(),
    })
    .where(and(
      eq(shipments.id, shipmentId),
      eq(shipments.isReturn, true),
      eq(shipments.voided, false),
      sql`not (coalesce(${shipments.selectedRateJson}, '{}'::jsonb) ? 'customerShippingMoneyPolicyVersion')`,
    ))
    .returning({ selectedRateJson: shipments.selectedRateJson });
  const winner = readFrozenCustomerShippingMoney(updated?.selectedRateJson);
  if (winner) return winner;

  const [concurrent] = await db
    .select({ selectedRateJson: shipments.selectedRateJson })
    .from(shipments)
    .where(eq(shipments.id, shipmentId))
    .limit(1);
  const concurrentSnapshot = readFrozenCustomerShippingMoney(concurrent?.selectedRateJson);
  if (!concurrentSnapshot) throw new Error('Customer shipping money snapshot could not be frozen');
  return concurrentSnapshot;
}
