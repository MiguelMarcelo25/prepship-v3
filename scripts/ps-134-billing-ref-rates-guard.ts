/**
 * PS-134 guard — billing reference-rate ETL is service-owned; classification + min-select
 * + non-destructive upsert preserved. Behavioral (pure helper) + static delegation checks.
 *
 *   npx tsx scripts/ps-134-billing-ref-rates-guard.ts
 */
import { readFileSync } from 'node:fs';

// Dummy env so the (db-bound) service imports cleanly; the guard only calls the PURE
// selectBestRefRates — no DB connection is opened.
process.env.VERCEL ??= '1';
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/test';
process.env.SUPABASE_URL ??= 'http://localhost';

const { selectBestRefRates } = await import('../src/services/billing-ref-rates');

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures += 1;
    console.error(`FAIL ${name}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── classification + min-select (preserve exact original semantics) ──
check('usps classified', selectBestRefRates([{ carrier: 'usps_priority', cost: 5 }]), { bestUsps: 5, bestUps: null });
check('stamps -> usps bucket', selectBestRefRates([{ carrier: 'stamps_com', cost: 4 }]), { bestUsps: 4, bestUps: null });
check('ups classified', selectBestRefRates([{ carrier: 'ups_walleted', cost: 8 }]), { bestUsps: null, bestUps: 8 });
check('uppercase normalized', selectBestRefRates([{ carrier: 'USPS Priority', cost: 6 }]), { bestUsps: 6, bestUps: null });
check('fedex/other skipped', selectBestRefRates([{ carrier: 'fedex_ground', cost: 3 }]), { bestUsps: null, bestUps: null });
check('usps min-select', selectBestRefRates([{ carrier: 'usps', cost: 3.5 }, { carrier: 'usps', cost: 2.8 }]), { bestUsps: 2.8, bestUps: null });
check('ups min-select', selectBestRefRates([{ carrier: 'ups', cost: 8 }, { carrier: 'ups', cost: 7.99 }]), { bestUsps: null, bestUps: 7.99 });
check('mixed buckets', selectBestRefRates([{ carrier: 'usps', cost: 4 }, { carrier: 'ups', cost: 9 }]), { bestUsps: 4, bestUps: 9 });
check('empty -> nulls', selectBestRefRates([]), { bestUsps: null, bestUps: null });
check('non-finite cost ignored', selectBestRefRates([{ carrier: 'usps', cost: 'abc' }]), { bestUsps: null, bestUps: null });

// ── static: service-owned + non-destructive upsert + route delegates ──
{
  const svc = readFileSync('src/services/billing-ref-rates.ts', 'utf8');
  check('service hard-limits 5000', /limit 5000/.test(svc), true);
  check('service keeps non-destructive coalesce upsert', /ref_usps_rate = coalesce\(order_overrides\.ref_usps_rate, excluded\.ref_usps_rate\)/.test(svc), true);

  const route = readFileSync('src/routes/billing.ts', 'utf8');
  check('route delegates to backfillReferenceRates', /backfillReferenceRates\(/.test(route), true);
  check('route no longer inlines the ETL loop', /bestUsps === null && bestUps === null/.test(route), false);
}

if (failures > 0) {
  console.error(`\nFAIL PS-134 billing ref-rates guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-134 billing ref-rates guard');
