import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orderAutomationState } from '../../db/schema/automations.js';
import { describeShippingService } from '../../lib/shipping-service-eligibility.js';

/**
 * carrier.prefer / service.prefer, applied to Best Rate ranking.
 *
 * A preference is a TIE-BREAK, never a filter. If the preferred carrier has no
 * selectable rate the order still gets the cheapest available one -- an
 * automation must not be able to leave an order unrated. To exclude, use
 * carrier.exclude, which is a different action with different consequences.
 *
 * This CAN select a more expensive rate than the cheapest, which is the whole
 * point and also why it is gated: AUTOMATION_PREFERENCE_RANKING is default-OFF,
 * matching how every other money-path behaviour change in this codebase ships.
 * With the flag off, ranking is byte-identical to before.
 */

export type RatePreference = { carrier: string | null; service: string | null };

export function isAutomationPreferenceRankingEnabled(): boolean {
  return String(process.env.AUTOMATION_PREFERENCE_RANKING ?? '').trim().toLowerCase() === 'true';
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Pure half, so the mapping is testable without a database. */
export function preferenceFromPlan(plan: unknown): RatePreference | null {
  if (typeof plan !== 'object' || plan === null) return null;
  const source = plan as { preferredCarrier?: unknown; preferredService?: unknown };
  const carrier = scalarValue(source.preferredCarrier);
  const service = scalarValue(source.preferredService);
  if (!carrier && !service) return null;
  return { carrier, service };
}

function scalarValue(choice: unknown): string | null {
  if (typeof choice !== 'object' || choice === null) return null;
  const value = (choice as { value?: unknown }).value;
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

export async function loadOrderRatePreference(orderId: number): Promise<RatePreference | null> {
  if (!isAutomationPreferenceRankingEnabled()) return null;
  const [row] = await db
    .select({ plan: orderAutomationState.plan })
    .from(orderAutomationState)
    .where(eq(orderAutomationState.orderId, orderId))
    .limit(1);
  return preferenceFromPlan(row?.plan);
}

/**
 * Does this rate satisfy the preference?
 *
 * Matched through describeShippingService, the same descriptor the eligibility
 * layer uses, so "ups" matches whether the provider spelled it in carrierCode,
 * carrierId or carrierName -- rather than a second ad-hoc idea of what a
 * carrier is.
 *
 * When BOTH a carrier and a service are preferred, both must match: the pair
 * names one specific offering, and satisfying half of it is not what was asked.
 */
export function rateMatchesPreference(rate: unknown, preference: RatePreference | null): boolean {
  if (!preference) return false;
  const descriptor = describeShippingService(rate);
  const carrierOk = preference.carrier == null || [
    descriptor.carrierId,
    descriptor.carrierCode,
    descriptor.carrierName,
  ].some((candidate) => normalize(candidate) === normalize(preference.carrier));
  const serviceOk = preference.service == null || [
    descriptor.serviceCode,
    descriptor.serviceName,
  ].some((candidate) => normalize(candidate) === normalize(preference.service));
  return carrierOk && serviceOk;
}

/**
 * Narrows a already-ranked candidate list to the preferred ones, or returns it
 * untouched when nothing matches.
 *
 * Deliberately does NOT re-sort: the caller has already applied the canonical
 * ordering (marked total, then cost), so taking the preferred subset in place
 * keeps that ordering and the cheapest preferred rate stays first. Re-sorting
 * here would be a second ranking implementation.
 */
export function narrowToPreferred<T>(ranked: T[], preference: RatePreference | null): T[] {
  if (!preference || ranked.length === 0) return ranked;
  const preferred = ranked.filter((rate) => rateMatchesPreference(rate, preference));
  return preferred.length > 0 ? preferred : ranked;
}
