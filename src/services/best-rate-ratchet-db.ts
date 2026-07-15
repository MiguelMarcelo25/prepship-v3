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
import { and, eq, isNull, sql } from 'drizzle-orm';
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

export type BestRateRatchetPersistResult = {
  persisted: boolean;
  blocked: boolean;
};

type BestRateRatchetPatch = Omit<
  Partial<typeof orderOverrides.$inferInsert>,
  'orderId'
> & {
  bestRateJson: unknown;
};

/**
 * Atomically applies the automated no-downgrade rule with optimistic CAS.
 * If another instance changes best_rate_json after our read, this re-reads the
 * winner and evaluates the canonical pure rule again before writing.
 */
export async function persistBestRateWithRatchet(
  orderId: number,
  patch: BestRateRatchetPatch,
  connection: typeof db = db,
): Promise<BestRateRatchetPersistResult> {
  const incomingDto = safeNormalize(patch.bestRateJson);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [prior] = await connection
      .select({
        orderId: orderOverrides.orderId,
        bestRateJson: orderOverrides.bestRateJson,
      })
      .from(orderOverrides)
      .where(eq(orderOverrides.orderId, orderId))
      .limit(1);

    if (prior && incomingDto && isNoDowngradeBlocked(safeNormalize(prior.bestRateJson), incomingDto)) {
      return { persisted: false, blocked: true };
    }

    if (!prior) {
      const inserted = await connection
        .insert(orderOverrides)
        .values({ orderId, ...patch })
        .onConflictDoNothing({ target: orderOverrides.orderId })
        .returning({ orderId: orderOverrides.orderId });
      if (inserted.length > 0) return { persisted: true, blocked: false };
      continue;
    }

    const priorStillCurrent = prior.bestRateJson == null
      ? isNull(orderOverrides.bestRateJson)
      : sql`${orderOverrides.bestRateJson} IS NOT DISTINCT FROM ${JSON.stringify(prior.bestRateJson)}::jsonb`;
    const updated = await connection
      .update(orderOverrides)
      .set(patch)
      .where(and(eq(orderOverrides.orderId, orderId), priorStillCurrent))
      .returning({ orderId: orderOverrides.orderId });
    if (updated.length > 0) return { persisted: true, blocked: false };
  }

  throw new Error(`best-rate ratchet contention did not settle for order ${orderId}`);
}
