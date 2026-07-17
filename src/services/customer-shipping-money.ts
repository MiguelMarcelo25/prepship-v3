import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shipments } from '../db/schema/shipments.js';
import { roundMoney } from '../lib/money.js';
import {
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT,
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD,
  HUGRAB_SHIPPING_RATE_OVERRIDE_CLIENT_NAME,
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
  clientName?: string | null;
  hugrabShippingRateOverride?: HugrabShippingRateOverrideConfig | null;
};

type CustomerShippingMoneyRow = {
  shipmentId: number;
  orderId: number | null;
  clientId: number | null;
  clientName: string | null;
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
      clientName: input.clientName,
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

async function loadCustomerShippingMoneyRow(shipmentId: number): Promise<CustomerShippingMoneyRow | null> {
  const rows = await db.execute<CustomerShippingMoneyRow>(sql`
    select
      s.id as "shipmentId",
      s.order_id as "orderId",
      coalesce(s.client_id, o.client_id, store_client.id) as "clientId",
      c.name as "clientName",
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
      coalesce(
        b.hugrab_shipping_rate_override_enabled,
        upper(c.name) = ${HUGRAB_SHIPPING_RATE_OVERRIDE_CLIENT_NAME}
      ) as "hugrabOverrideEnabled",
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
  return rows[0] ?? null;
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
): Promise<CustomerShippingMoneyDecision> {
  if (!row.billingActive) throw new Error('Customer shipping policy is inactive');
  if (row.clientId == null || !row.clientName) throw new Error('Customer shipping policy client is unavailable');
  // PS-437 fail-closed boundary: new return freezes require the exact provider
  // total persisted in selected_rate_cost. Legacy component fallbacks are audit
  // evidence only and must never become a newly frozen customer-money fact.
  const selectedRateCost = finiteNumber(row.selectedRateCost);
  if (selectedRateCost == null || selectedRateCost <= 0) {
    throw new Error('Selected/purchased label cost is unavailable');
  }
  const perAccountMarkups = process.env.BILLING_PER_ACCOUNT_MARKUP === 'on'
    ? await loadCarrierMarkups()
    : null;
  const resolvedMarkup = resolveCanonicalMarkup({
    carrierAccountMarkup: perAccountMarkups
      ? resolvePerAccountMarkupRule(perAccountMarkups, row.providerAccountId)
      : null,
    clientShippingMarkupPct: finiteNumber(row.shippingMarkupPct) ?? 0,
    clientShippingMarkupFlat: finiteNumber(row.shippingMarkupFlat) ?? 0,
  });
  return resolveCustomerShippingMoney({
    selectedRateCost,
    billingMode: row.billingMode,
    carrierCode: row.carrierCode,
    refUspsRate: finiteNumber(row.refUspsRate),
    refUpsRate: finiteNumber(row.refUpsRate),
    shippingMarkupPct: resolvedMarkup?.pct ?? 0,
    shippingMarkupFlat: resolvedMarkup?.flat ?? 0,
    shippingMarkupKind: resolvedMarkup?.adjustmentKind ?? 'customer_profit_markup',
    clientName: row.clientName,
    hugrabShippingRateOverride: {
      enabled: row.hugrabOverrideEnabled,
      threshold: row.hugrabOverrideThreshold,
      amount: row.hugrabOverrideAmount,
    },
  });
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
 * Freeze the canonical return money tuple on shipments.selected_rate_json.
 * Per user override unlock shipped data on 2026-05-23: PS-437 updates only the
 * one explicitly requested return shipment, never status/history/postage, and
 * never rewrites a snapshot once the full policy-versioned tuple exists.
 */
export async function freezeReturnCustomerShippingMoney(
  shipmentId: number,
): Promise<FrozenCustomerShippingMoney> {
  const row = await loadCustomerShippingMoneyRow(shipmentId);
  if (!row || !row.isReturn || row.voided) throw new Error('Active return shipment not found');
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
