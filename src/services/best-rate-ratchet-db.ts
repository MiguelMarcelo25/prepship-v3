// PS-271 — the DB-bound half of the no-downgrade ratchet (imperative shell over the pure decision in
// best-rate-ratchet.ts). Reads the order's currently-persisted best rate and decides whether an
// `incoming` best would be a same-inputs price DOWNGRADE — in which case the automated persist site
// should keep the prior instead of overwriting it with a thin/flickery re-quote.
//
// Normalizes BOTH sides through the canonical DTO so the comparison is apples-to-apples regardless of
// which writer persisted the prior (the backfill stores a raw record; the strict-recalc stores a
// normalized DTO). A normalize failure on either side -> treated as "not a downgrade" so a persist is
// NEVER blocked on missing or garbled prior data. The pure rule stays in best-rate-ratchet.ts so the
// offline guard exercises it without a database.
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { orderOverrides } from '../db/schema/orders';
import { normalizeOrderBestRateDto, type OrderBestRateDto } from './order-rate-dto';
import { isNoDowngradeBlocked } from './best-rate-ratchet';

function safeNormalize(value: unknown): OrderBestRateDto | null {
  if (value == null) return null;
  try {
    return normalizeOrderBestRateDto(value, 'ratchet');
  } catch {
    return null;
  }
}

/** True when persisting `incoming` over the order's stored best would be a same-inputs downgrade. */
export async function isPersistedBestDowngrade(orderId: number, incoming: unknown): Promise<boolean> {
  const incomingDto = safeNormalize(incoming);
  if (!incomingDto) return false; // can't compare the incoming -> never block
  const [prior] = await db
    .select({ bestRateJson: orderOverrides.bestRateJson })
    .from(orderOverrides)
    .where(eq(orderOverrides.orderId, orderId))
    .limit(1);
  const priorDto = safeNormalize(prior?.bestRateJson);
  return isNoDowngradeBlocked(priorDto, incomingDto);
}
