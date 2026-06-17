/**
 * PS-220 guard — SHIPP house-account next-best-rate resolver.
 *
 * MODEL: SHIPP is DRP's house carrier. When SHIPP wins for an OPTED-IN client, DRP pays the
 * SHIPP rate (drp_cost) but bills the cheapest ELIGIBLE non-SHIPP rate (customer_rate); the
 * spread is DRP's margin (always >= 0). No eligible competitor => customer_rate = drp_cost,
 * margin 0. Not opted in / SHIPP not the winner => no house behavior.
 *
 * This slice (1 of N) pins the PURE resolver + the sidecar table + the lockdown invariants.
 * Capture wiring (projected stamp / realized row), billing, and display land in later slices.
 *
 *   npx tsx scripts/ps-220-house-margin-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  isHouseShippRate,
  resolveNextBestNonHouseRate,
} from '../src/lib/next-best-non-house-rate';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const CONTEXT = { clientId: 10 };
const OPTED_IN = { houseAccountOptIn: true };

// SHIPP (house) — provider IS the only reliable identity. The Shipp connector rewrites
// carrier_code to fedex/ups/etc, so a SHIPP rate can carry carrier_code:'fedex'.
const SHIPP_SUREPOST = { provider: 'shipp', carrier_code: 'ups', service_code: 'ups_surepost', shipping_amount: { amount: 8.5 } };
const SHIPP_AS_FEDEX = { provider: 'shipp', carrier_code: 'fedex', service_code: 'fedex_ground', shipping_amount: { amount: 8.4 } };
// Real competitors (provider !== shipp).
const FEDEX_GROUND = { provider: 'fedex', carrier_code: 'fedex', service_code: 'fedex_ground', shipping_amount: { amount: 10.3 } };
const USPS_GA = { provider: 'shipstation', carrier_code: 'stamps_com', service_code: 'usps_ground_advantage', shipping_amount: { amount: 9.64 } };
const UPS_UNPRICED = { provider: 'ups', carrier_code: 'ups', service_code: 'ups_ground', shipping_amount: { amount: 0 } };

// ── isHouseShippRate keys on provider, never carrier_code ─────────────────────
check('isHouseShippRate: provider shipp => true', isHouseShippRate(SHIPP_SUREPOST) === true);
check('isHouseShippRate: SHIPP rewritten to carrier_code fedex is STILL house (provider shipp)',
  isHouseShippRate(SHIPP_AS_FEDEX) === true);
check('isHouseShippRate: real fedex (provider fedex) is NOT house',
  isHouseShippRate(FEDEX_GROUND) === false);
check('isHouseShippRate: real usps is NOT house', isHouseShippRate(USPS_GA) === false);

// ── resolver ──────────────────────────────────────────────────────────────────
{
  // Opted in + SHIPP winner + competitors => cheapest ELIGIBLE non-SHIPP (USPS $9.64 < FedEx $10.30),
  // the SHIPP-as-fedex trap row dropped (provider shipp), the $0 ups dropped (unpriced).
  const r = resolveNextBestNonHouseRate({
    eligibleRates: [SHIPP_SUREPOST, SHIPP_AS_FEDEX, FEDEX_GROUND, USPS_GA, UPS_UNPRICED],
    context: CONTEXT,
    client: OPTED_IN,
  });
  check('next-best is the cheapest priced non-SHIPP ($9.64 USPS)',
    r != null && r.total === 9.64 && (r.rate as { provider?: string }).provider === 'shipstation',
    `got ${r ? r.total + ' / ' + (r.rate as { provider?: string }).provider : 'null'}`);
  check('competitorCount counts only priced non-SHIPP (fedex + usps = 2)',
    r != null && r.competitorCount === 2, `got ${r?.competitorCount}`);
  check('next-best is never a SHIPP rate', r != null && !isHouseShippRate(r.rate));
}

{
  // No eligible non-SHIPP competitor => null (caller sets customer_rate = drp_cost, margin 0).
  const r = resolveNextBestNonHouseRate({
    eligibleRates: [SHIPP_SUREPOST, SHIPP_AS_FEDEX, UPS_UNPRICED],
    context: CONTEXT,
    client: OPTED_IN,
  });
  check('no priced non-SHIPP competitor => null (pass-through)', r === null);
}

{
  // Not opted in => no house behavior at all, even with competitors present.
  const r = resolveNextBestNonHouseRate({
    eligibleRates: [SHIPP_SUREPOST, FEDEX_GROUND, USPS_GA],
    context: CONTEXT,
    client: { houseAccountOptIn: false },
  });
  check('client not opted in => null (no house behavior)', r === null);
}

// ── structural pins ─────────────────────────────────────────────────────────
const resolverSrc = readFileSync('src/lib/next-best-non-house-rate.ts', 'utf8');
check('resolver keys SHIPP on provider, NOT carrier_code',
  /normalizeProviderKey\([\s\S]*?\)\s*===\s*'shipp'/.test(resolverSrc) &&
  !/carrier_?code[^\n]*===[^\n]*'shipp'/i.test(resolverSrc));
check('resolver reuses the canonical eligibility filter (no re-implemented loop)',
  resolverSrc.includes('filterEligibleShippingServices'));
check('resolver uses the same charge basis as the winner (rateTotal + isPricedRate)',
  resolverSrc.includes('rateTotal') && resolverSrc.includes('isPricedRate'));

// ── sidecar table is lockdown-safe (new table, never ALTER orders/shipments) ──
const migration = readFileSync('drizzle/0049_order_competitive_rate.sql', 'utf8');
check('migration creates the sidecar table', /CREATE TABLE IF NOT EXISTS order_competitive_rate/i.test(migration));
check('migration enforces the margin>=0 invariant in the DB', /CHECK\s*\(\s*margin\s*>=\s*0\s*\)/i.test(migration));
check('migration NEVER alters the locked orders/shipments tables',
  !/ALTER\s+TABLE\s+(orders|shipments)\b/i.test(migration) &&
  !/\b(UPDATE|DELETE)\s+(FROM\s+)?(orders|shipments)\b/i.test(migration));

// ── slice 2: DTO carrier + projected stamp + opt-in + redaction ──────────────
const dto = readFileSync('src/services/order-rate-dto.ts', 'utf8');
check('OrderBestRateDto carries nextBestNonHouseRate + houseMargin (survives the whitelist normalizer)',
  /nextBestNonHouseRate:/.test(dto) && /houseMargin:/.test(dto) && dto.includes('normalizeNextBestNonHouseRate'));

const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
// houseMargin must be redacted from BOTH the rate (browser) and the orders (list/export) serializers.
// The rates.ts redaction ships in this slice; the orders.ts RATE_MONEY_FIELD_KEYS line ships with the
// orders.ts slice (that file is mid-edit by a parallel ticket). Both MUST land before any client opts
// in (P4 default-off ⇒ houseMargin is never populated until then, so no leak window in between).
check('houseMargin redacted from the rates (rate browser) serializer RATE_MONEY_FIELD_KEYS',
  ratesRoute.includes("'houseMargin'"));
check('projected stamp fires only for a SHIPP winner + opted-in client, over combinedRates',
  ratesRoute.includes('isHouseShippRate(cheapest)') &&
  ratesRoute.includes('clientHouseAccountEnabled') &&
  /resolveNextBestNonHouseRate\(\{[\s\S]*?eligibleRates: combinedRates/.test(ratesRoute));
check('opt-in column is NOT declared on the drizzle billing_config schema (avoids the runtime-DDL gotcha)',
  !/house_account_enabled|houseAccountEnabled/.test(readFileSync('src/db/schema/billing.ts', 'utf8')));
check('opt-in read is fail-safe (false on error) and idempotently ensures the column',
  /clientHouseAccountEnabled/.test(readFileSync('src/services/house-account-opt-in.ts', 'utf8')) &&
  /ADD COLUMN IF NOT EXISTS house_account_enabled/.test(readFileSync('src/services/house-account-opt-in.ts', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-220 house-margin guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-220 house-margin guard');
