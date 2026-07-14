import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { billingRefRates } from '../db/schema/billing';
import { roundMoney } from '../lib/money';

export type BillingReferenceRateInput = {
  weightOz: number;
  zipTo: string;
  carrier: string;
  service?: string | null;
  cost: number;
  source?: string | null;
  fetchedAt?: Date;
};

export type NormalizedBillingReferenceRate = {
  weightOz: number;
  zipTo: string;
  carrier: string;
  service: string | null;
  cost: string;
  source: string | null;
  fetchedAt: Date;
};

function identityKey(rate: Pick<NormalizedBillingReferenceRate, 'weightOz' | 'zipTo' | 'carrier' | 'service'>): string {
  return JSON.stringify([rate.weightOz, rate.zipTo, rate.carrier, rate.service]);
}
/**
 * Normalize the durable reference-rate identity before it reaches Postgres.
 * Last input wins when one request repeats the same logical rate, matching the
 * database upsert's refresh semantics without triggering a multi-hit conflict.
 */
export function normalizeBillingReferenceRates(
  rates: readonly BillingReferenceRateInput[],
): NormalizedBillingReferenceRate[] {
  const byIdentity = new Map<string, NormalizedBillingReferenceRate>();
  for (const rate of rates) {
    const normalized: NormalizedBillingReferenceRate = {
      weightOz: rate.weightOz,
      zipTo: rate.zipTo.trim().toUpperCase(),
      carrier: rate.carrier.trim(),
      service: rate.service?.trim() || null,
      cost: roundMoney(rate.cost).toFixed(2),
      source: rate.source?.trim() || null,
      fetchedAt: rate.fetchedAt ?? new Date(),
    };
    byIdentity.set(identityKey(normalized), normalized);
  }
  return [...byIdentity.values()];
}

/** Canonical writer for manual and live billing reference-rate ingestion. */
export async function upsertBillingReferenceRates(
  rates: readonly BillingReferenceRateInput[],
): Promise<number> {
  const normalized = normalizeBillingReferenceRates(rates);
  if (normalized.length === 0) return 0;
  const persisted = await db
    .insert(billingRefRates)
    .values(normalized)
    .onConflictDoUpdate({
      target: [
        billingRefRates.weightOz,
        billingRefRates.zipTo,
        billingRefRates.carrier,
        billingRefRates.service,
      ],
      set: {
        cost: sql`excluded.cost`,
        source: sql`excluded.source`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    })
    .returning({ id: billingRefRates.id });
  return persisted.length;
}
