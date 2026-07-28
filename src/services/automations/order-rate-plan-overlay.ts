import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orderAutomationState } from '../../db/schema/automations.js';

/**
 * insurance.require and confirmation.set, applied to a rate request.
 *
 * Both were reduced into the plan, persisted, and read by nobody -- an
 * operator could publish "require $500 insurance", watch the run succeed, and
 * ship uninsured. These are the readers.
 *
 * Both overlay the REQUEST, and in both cases an explicit operator choice
 * wins. A rule is a standing instruction; the person looking at this order now
 * knows something the rule cannot.
 */

export type OrderRatePlanOverlay = {
  /** Floor for the insured value. Never lowers what the operator asked for. */
  insuranceMinimumValue: number | null;
  /** Used only when the operator expressed no confirmation preference. */
  confirmation: string | null;
};

const EMPTY: OrderRatePlanOverlay = { insuranceMinimumValue: null, confirmation: null };

export async function loadOrderRatePlanOverlay(orderId: number): Promise<OrderRatePlanOverlay> {
  const [row] = await db
    .select({ plan: orderAutomationState.plan })
    .from(orderAutomationState)
    .where(eq(orderAutomationState.orderId, orderId))
    .limit(1);
  return ratePlanOverlayFromPlan(row?.plan);
}

/** Pure half, so the mapping is testable without a database. */
export function ratePlanOverlayFromPlan(plan: unknown): OrderRatePlanOverlay {
  if (typeof plan !== 'object' || plan === null) return EMPTY;
  const source = plan as { insurance?: unknown; confirmation?: unknown };

  let insuranceMinimumValue: number | null = null;
  if (typeof source.insurance === 'object' && source.insurance !== null) {
    const raw = (source.insurance as { minimumValue?: unknown }).minimumValue;
    const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      insuranceMinimumValue = value;
    }
  }

  // The PROVIDER on the action is deliberately ignored here.
  //
  // Whether a shipment insures via carrier declared value or ParcelGuard is
  // decided by the account's capability and the insured value (PS-170), and a
  // rule cannot know whether a given account supports carrier DV. Honouring
  // the amount while leaving provider selection with its existing owner is
  // correct; letting a rule force 'carrier' on an account that cannot do it
  // would produce an unpurchasable rate.

  let confirmation: string | null = null;
  if (typeof source.confirmation === 'object' && source.confirmation !== null) {
    const value = (source.confirmation as { value?: unknown }).value;
    if (value != null) {
      const text = String(value).trim();
      if (text) confirmation = text;
    }
  }

  return { insuranceMinimumValue, confirmation };
}

/**
 * Raises an insured value to the automation floor.
 *
 * insurance.require is actionClass 'minimum', so it can only ever increase
 * cover -- an operator who asked for more keeps it, and a rule can never
 * quietly reduce insurance on a shipment.
 */
export function applyInsuranceFloor(
  operatorValue: number | null | undefined,
  floor: number | null,
): number | null {
  if (floor == null) return operatorValue ?? null;
  const current = typeof operatorValue === 'number' && Number.isFinite(operatorValue) ? operatorValue : 0;
  return Number(Math.max(current, floor).toFixed(2));
}
