import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orderAutomationState } from '../../db/schema/automations.js';
import type { ShippingAutomationRule } from '../../lib/shipping-service-eligibility.js';

/**
 * Turns an order's persisted automation plan into carrier/service exclusions
 * the rate path already knows how to apply.
 *
 * The plan side of this was complete: reduceAutomationIntents already collapses
 * every carrier.exclude / service.exclude intent into plan.excludedCarriers and
 * plan.excludedServices, and setState persists that onto
 * order_automation_state. Nothing read it. The two actions were selectable in
 * the builder, recorded a plan, and changed nothing about which rates came
 * back -- an operator could exclude a carrier and still be quoted it.
 *
 * Deliberately expressed as ShippingAutomationRule rather than a new filter.
 * That type is the canonical shape the eligibility layer already evaluates for
 * the Carrier & Service Controls, so per-order exclusions flow through
 * filterCarrierAccountsForAutomation and filterEligibleShippingServices
 * unchanged. A second filtering path would be a second source of truth for
 * "may this order use this carrier", which is exactly what PS-316 forbids.
 *
 * `source` marks the provenance so a diagnostic can tell an operator-configured
 * store control apart from a per-order automation decision.
 *
 * HUGRAB carrier-disable protection still applies: findDisabledCarrierAutomationRule
 * short-circuits on isHugrabCarrierDisableProtected before consulting any rule,
 * so an automation cannot disable a protected carrier by this route either.
 */
export async function loadOrderAutomationExclusionRules(input: {
  orderId: number;
  clientId: number | null;
  storeId: number | null;
}): Promise<ShippingAutomationRule[]> {
  // Scope is REQUIRED, not decorative. matchesContext ends with
  // `return ruleClientId != null || ruleStoreId != null`, so a rule carrying
  // neither matches nothing at all -- a deliberate guard against an unscoped
  // rule disabling a carrier everywhere. An earlier cut of this left the scope
  // off and the carrier exclusion silently did nothing.
  if (input.clientId == null && input.storeId == null) return [];

  const [row] = await db
    .select({ plan: orderAutomationState.plan })
    .from(orderAutomationState)
    .where(eq(orderAutomationState.orderId, input.orderId))
    .limit(1);

  return exclusionRulesFromPlan(row?.plan, {
    clientId: input.clientId,
    storeId: input.storeId,
  });
}

/**
 * Pure half, so the mapping can be tested without a database and reused by
 * callers that already hold the plan.
 */
export function exclusionRulesFromPlan(
  plan: unknown,
  scope: { clientId: number | null; storeId: number | null },
): ShippingAutomationRule[] {
  if (typeof plan !== 'object' || plan === null) return [];
  if (scope.clientId == null && scope.storeId == null) return [];
  const { excludedCarriers, excludedServices } = plan as {
    excludedCarriers?: unknown;
    excludedServices?: unknown;
  };

  const rules: ShippingAutomationRule[] = [];

  for (const id of asIdList(excludedCarriers)) {
    rules.push({
      type: 'carrier',
      clientId: scope.clientId,
      storeId: scope.storeId,
      // The builder collects carrier ids, but a rule written against a carrier
      // CODE ('ups') should still bite. Setting both lets the existing matcher
      // resolve whichever the descriptor carries.
      carrierId: id,
      carrierCode: id,
      disabled: true,
      reason: 'Excluded by an automation rule',
      source: 'automation_plan',
    });
  }
  for (const id of asIdList(excludedServices)) {
    rules.push({
      type: 'service',
      clientId: scope.clientId,
      storeId: scope.storeId,
      serviceCode: id,
      disabled: true,
      reason: 'Excluded by an automation rule',
      source: 'automation_plan',
    });
  }
  return rules;
}

function asIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (entry == null) continue;
    const id = String(entry).trim();
    if (id) seen.add(id);
  }
  return [...seen];
}
