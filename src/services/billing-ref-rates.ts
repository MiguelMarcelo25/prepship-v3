// PS-134: billing reference-rate backfill ETL, extracted verbatim from the inline
// /billing/backfill-ref-rates Shape-B handler so the money input is service-owned (the route
// becomes validate -> service -> return). Behavior is preserved exactly: date/client filters,
// hard limit 5000, USPS/UPS carrier classification, per-bucket min-select, and the
// NON-DESTRUCTIVE `coalesce(existing, excluded)` upsert into order_overrides.ref_*_rate.
//
// order_overrides is not a lockdown surface; the SELECT reads orders regardless of status
// (read), and the upsert writes only reference-rate columns (never order/shipment status).

import { sql } from 'drizzle-orm';
import { db } from '../db/client';

export type BackfillRefRatesInput = {
  from: string | null;
  to: string | null;
  clientId: number | null;
};

export type BackfillRefRatesResult = {
  ok: boolean;
  filled: number;
  missing: number;
  total: number;
  message?: string;
};

/**
 * PURE: pick the cheapest USPS and UPS reference rate from cached rows. USPS bucket =
 * carrier contains 'usps' or 'stamps'; UPS bucket = carrier contains 'ups'. Min-select per
 * bucket (first-seen wins on ties). Mirrors the original inline loop exactly — unit-testable.
 */
export function selectBestRefRates(
  cached: Array<{ carrier: string | null; cost: number | string }>,
): { bestUsps: number | null; bestUps: number | null } {
  let bestUsps: number | null = null;
  let bestUps: number | null = null;
  for (const r of cached) {
    const cost = Number(r.cost);
    if (!Number.isFinite(cost)) continue;
    const carrier = (r.carrier || '').toLowerCase();
    if (carrier.includes('usps') || carrier.includes('stamps')) {
      if (bestUsps === null || cost < bestUsps) bestUsps = cost;
    } else if (carrier.includes('ups')) {
      if (bestUps === null || cost < bestUps) bestUps = cost;
    }
  }
  return { bestUsps, bestUps };
}

export async function backfillReferenceRates(
  input: BackfillRefRatesInput,
): Promise<BackfillRefRatesResult> {
  const { from, to, clientId } = input;

  const ordersMissing = await db.execute<{
    order_id: number;
    weight_oz: number | null;
    zip5: string | null;
  }>(sql`
    select o.id as order_id, o.weight_oz as weight_oz,
           substring(regexp_replace(coalesce(o.ship_to_postal_code, ''), '\\D', '', 'g') from 1 for 5) as zip5
    from orders o
    left join order_overrides ov on ov.order_id = o.id
    where (ov.ref_usps_rate is null or ov.ref_ups_rate is null)
      and o.weight_oz is not null
      and o.ship_to_postal_code is not null
      ${from ? sql`and o.order_date >= ${from}::timestamptz` : sql``}
      ${to ? sql`and o.order_date <= ${to}::timestamptz` : sql``}
      ${clientId ? sql`and o.client_id = ${clientId}` : sql``}
    limit 5000
  `);

  if (ordersMissing.length === 0) {
    return {
      ok: true,
      filled: 0,
      missing: 0,
      total: 0,
      message: 'All orders already have reference rates',
    };
  }

  let filled = 0;
  let missing = 0;

  for (const row of ordersMissing) {
    const weightOz = Math.round(Number(row.weight_oz ?? 1));
    const zip5 = row.zip5 ?? '';
    if (!zip5 || zip5.length !== 5) {
      missing += 1;
      continue;
    }

    const cached = await db.execute<{ carrier: string; cost: string }>(sql`
      select carrier, cost from billing_ref_rates
      where weight_oz = ${weightOz} and zip_to = ${zip5}
      order by fetched_at desc
      limit 20
    `);

    if (!cached.length) {
      missing += 1;
      continue;
    }

    const { bestUsps, bestUps } = selectBestRefRates(cached);
    if (bestUsps === null && bestUps === null) {
      missing += 1;
      continue;
    }

    await db.execute(sql`
      insert into order_overrides (order_id, ref_usps_rate, ref_ups_rate, updated_at)
      values (${row.order_id}, ${bestUsps?.toFixed(2) ?? null}, ${bestUps?.toFixed(2) ?? null}, now())
      on conflict (order_id) do update set
        ref_usps_rate = coalesce(order_overrides.ref_usps_rate, excluded.ref_usps_rate),
        ref_ups_rate = coalesce(order_overrides.ref_ups_rate, excluded.ref_ups_rate),
        updated_at = now()
    `);
    filled += 1;
  }

  return {
    ok: true,
    filled,
    missing,
    total: ordersMissing.length,
  };
}
