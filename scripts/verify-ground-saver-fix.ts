#!/usr/bin/env tsx
// Confirms the Ground Saver fix:
//   1. Inspect the existing rate_cache to see whether old entries are
//      missing UPS Ground Saver / SurePost (they should be, since the OLD
//      filter stripped them before caching).
//   2. Optionally quote ShipStation rates against ORION (or another UPS
//      account) through the CarrierConnector boundary, bypassing isBlockedRate, and
//      confirm the SS API itself returns ups_surepost_* service codes.
//      The OLD code would block these; the NEW code passes them through.
import 'dotenv/config';
import { sql as pgClient, db } from '../src/db/client';
import { sql, like } from 'drizzle-orm';
import { rateCache } from '../src/db/schema/rates';
import {
  listCarrierAccounts,
  quoteCarrierRates,
} from '../src/services/carrier-connector-orchestrator';

function log(label: string, value: unknown) {
  console.log(`  ${label.padEnd(34)} ${JSON.stringify(value)}`);
}

async function main() {
  console.log('\n=== Verify Ground Saver fix ===\n');

  // 1. Check existing rate_cache rows.
  const totals = await db.execute<{
    total: number;
    new_version: number;
    has_surepost: number;
  }>(sql`
    select
      count(*)::int as total,
      count(*) filter (where cache_key like 'v=ground-saver-v1|%')::int as new_version,
      count(*) filter (
        where rates::text ilike '%ups_surepost%'
           or rates::text ilike '%ups_ground_saver%'
           or rates::text ilike '%Ground Saver%'
      )::int as has_surepost
    from rate_cache
  `);
  console.log('rate_cache contents:');
  log('total cached rows', totals[0]?.total);
  log('with v=ground-saver-v1 prefix', totals[0]?.new_version);
  log('contain Ground Saver / SurePost', totals[0]?.has_surepost);
  console.log('');
  console.log('  Interpretation:');
  console.log('  - "with v=ground-saver-v1" should be 0 BEFORE deploy of new code,');
  console.log('    > 0 once the new code starts caching after the version bump.');
  console.log('  - "contain Ground Saver" should be ~0 today (old filter stripped');
  console.log('    them before caching) and grow once the new code populates new');
  console.log('    rows under the v=ground-saver-v1 cache_key prefix.');
  console.log('');

  // 2. Live probe of one UPS carrier account to prove SS API actually returns
  //    ups_surepost_* service codes for a typical residential parcel. We
  //    bypass isBlockedRate entirely via the connector-normalized response.
  console.log('Discovering UPS carriers from ShipStation...');
  const carriers = await listCarrierAccounts('shipstation', {
    dedupeKey: 'verify-ground-saver:carriers',
  });
  const upsCarriers = ((carriers.carriers ?? []) as Array<{
    carrier_id?: string;
    carrier_code?: string;
    nickname?: string;
    friendly_name?: string;
    disabled_by_billing_plan?: boolean;
  }>).filter(
    (c) => (c.carrier_code ?? '').toLowerCase() === 'ups' && !c.disabled_by_billing_plan
  );
  log('UPS carriers found', upsCarriers.length);
  if (!upsCarriers.length) {
    console.log('  No UPS carriers — abort.');
    return;
  }

  const sample = upsCarriers
    .find((c) => /orion/i.test(c.nickname ?? c.friendly_name ?? '')) ?? upsCarriers[0]!;
  log('probing carrier_id', sample.carrier_id);
  log('nickname', sample.nickname ?? sample.friendly_name);
  console.log('');

  console.log('POST /v2/rates/estimate (5 lb 7 oz, 11x8x5, residential, ZIP 29707)...');
  type EstimateRate = {
    service_code?: string;
    service_type?: string;
    package_type?: string | null;
    shipping_amount?: { amount?: number };
  };
  const probeBody = {
    carrier_ids: [sample.carrier_id],
    from_country_code: 'US',
    from_postal_code: '90248',
    to_country_code: 'US',
    to_postal_code: '29707',
    weight: { value: 87, unit: 'ounce' as const },
    address_residential_indicator: 'yes' as const,
    ship_date: new Date().toISOString(),
    dimensions: { length: 11, width: 8, height: 5, unit: 'inch' as const },
  };

  let rates: EstimateRate[];
  try {
    const payload = await quoteCarrierRates('shipstation', {
      body: probeBody,
      dedupeKey: `verify-ground-saver:estimate:${sample.carrier_id}`,
    });
    rates = payload.rates as EstimateRate[];
  } catch (err) {
    console.log('  SS API probe failed:', err instanceof Error ? err.message : err);
    return;
  }
  log('rates returned by SS', rates.length);
  console.log('');

  console.log('Sample of all returned rates (raw, no filtering applied):');
  for (const r of rates.slice(0, 20)) {
    console.log(
      `  ${r.shipping_amount?.amount?.toString().padStart(7)}  ${(r.service_code ?? '').padEnd(38)}  ${r.service_type ?? ''}`
    );
  }
  console.log('');

  // 3. Final assertion: are any returned rows blocked by the OLD filter list?
  const OLD_BLOCKED = new Set([
    'usps_media_mail',
    'usps_first_class_mail',
    'usps_library_mail',
    'usps_parcel_select',
    'usps_parcel_select_lightweight',
    'ups_surepost_1_lb_or_greater',
    'ups_surepost_less_than_1_lb',
  ]);
  const wouldBeBlocked = rates.filter((r) => OLD_BLOCKED.has(r.service_code ?? ''));
  log('rows blocked by OLD filter', wouldBeBlocked.length);
  if (wouldBeBlocked.length) {
    console.log('  ↳ Codes that the OLD code would have hidden:');
    for (const r of wouldBeBlocked) {
      console.log(`     ${r.service_code}  $${r.shipping_amount?.amount}  (${r.service_type})`);
    }
    console.log('');
    console.log('  CONFIRMED: these are exactly the rates the v4 UI was missing.');
    console.log('  The working-tree fix unblocks them.');
  } else {
    console.log('  No rows hit the OLD filter list. (This carrier may not offer');
    console.log('  Ground Saver — try a different UPS account.)');
  }
}

main()
  .catch((err) => {
    console.error('FAIL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgClient.end({ timeout: 5 });
  });
