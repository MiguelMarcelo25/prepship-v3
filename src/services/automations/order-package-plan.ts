import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orderAutomationState } from '../../db/schema/automations.js';
import type { PackageFactsRung } from '../package-facts-policy.js';

/**
 * The package a rule chose for this order, as a package-facts rung.
 *
 * package.set was selectable in the builder, reduced into plan.package, and
 * persisted onto order_automation_state -- and then nothing read it, so the
 * rule appeared to succeed while the order kept whatever package it already
 * had. This is the missing reader.
 *
 * Only a package IDENTITY is carried, never weight or dims. A preset is a
 * choice of box; the weight of what goes in it is measured, not decreed by a
 * rule. Returning dims here would let an automation silently overwrite an
 * operator's measured values through a lower precedence rung.
 *
 * Precedence lives in package-facts-policy.ts, not here: 'automation' sits
 * below an operator override and above the generic defaults.
 */
export async function loadOrderAutomationPackageRung(
  orderId: number,
): Promise<PackageFactsRung | null> {
  const [row] = await db
    .select({ plan: orderAutomationState.plan })
    .from(orderAutomationState)
    .where(eq(orderAutomationState.orderId, orderId))
    .limit(1);

  return packageRungFromPlan(row?.plan);
}

/** Pure half, so the mapping is testable without a database. */
export function packageRungFromPlan(plan: unknown): PackageFactsRung | null {
  if (typeof plan !== 'object' || plan === null) return null;
  const chosen = (plan as { package?: unknown }).package;
  if (typeof chosen !== 'object' || chosen === null) return null;

  // ScalarChoice from the conflict reducer: the winning value plus which rule
  // won it. Only the value matters here.
  const id = (chosen as { value?: unknown }).value;
  if (id == null) return null;
  const text = String(id).trim();
  if (!text) return null;

  return { selectedPackageId: text };
}
