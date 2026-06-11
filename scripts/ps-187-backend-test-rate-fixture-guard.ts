/**
 * PS-187 guard — backend-owned deterministic test-rate fixture (part 1 of 2).
 *
 * THE BUG: test orders got their rates from FE fabricators (OrdersView
 * buildTestRatesForShipment / buildTestMockRate) — frontend-owned money data on
 * a workflow the backend is supposed to own end-to-end, invisible to backend
 * tests, and a second copy of "what does a test rate look like".
 *
 * THE FIX (this part): canonical owner src/services/test-rate-fixture.ts —
 * a faithful port of the FE generator (FNV-1a jitter, same accounts/templates/
 * money formula) — gated in getRates on clients.is_test via the PS-186
 * loadClientIsTest authority. Fixture rates flow through the NORMAL pipeline
 * (best-rate pick, /browse selectedRateKey + snapshot stamping, FE translation)
 * and the PS-186 test-label policy independently forces mock labels at purchase
 * time, so a fixture can never buy postage.
 *
 * Part 2 (separate PR, replacement-first): delete the FE fabricators once DJ
 * verifies fixture parity live.
 *
 * Pins:
 *   1-4. Behavioral determinism of the pure module (same input → same output;
 *        seed sensitivity; full account×template coverage; marker fields).
 *   5.   Money parity with the FE algorithm (golden value computed from the
 *        ported formula — locks the port byte-for-byte).
 *   6-8. getRates gating: test client → fixture branch BEFORE any carrier call;
 *        gate uses the canonical loadClientIsTest; fixtures never cached.
 *
 *   npx tsx scripts/ps-187-backend-test-rate-fixture-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  buildTestFixtureRates,
  TEST_FIXTURE_CARRIER_CODE,
} from '../src/services/test-rate-fixture';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

const INPUT = { orderId: 1463, weightOz: 35, dimsL: 12, dimsW: 9, dimsH: 4 };

// ── 1. determinism ────────────────────────────────────────────────────────────
const a = buildTestFixtureRates(INPUT);
const b = buildTestFixtureRates(INPUT);
check('same input → identical output', JSON.stringify(a) === JSON.stringify(b));

// ── 2. seed sensitivity ───────────────────────────────────────────────────────
const c = buildTestFixtureRates({ ...INPUT, orderId: 1464 });
check('different order → different fixture money', JSON.stringify(a) !== JSON.stringify(c));

// ── 3. coverage: 5 accounts × 3 services ─────────────────────────────────────
check('15 rates (5 accounts × 3 service templates)', a.length === 15);
check('every rate is the prepship_test carrier',
  a.every((r) => r.carrier_code === TEST_FIXTURE_CARRIER_CODE));
check('every rate uses a synthetic 9000xx provider id',
  a.every((r) => /^se-9000\d{2}$/.test(String(r.carrier_id))));

// ── 4. markers ────────────────────────────────────────────────────────────────
check('every rate carries testFixture + mocked markers',
  a.every((r) => r.testFixture === true && r.mocked === true));
check('every rate has positive shipping money in the normalized shape',
  a.every((r) => {
    const amount = (r.shipping_amount as { amount?: unknown })?.amount;
    return typeof amount === 'number' && amount > 0;
  }));

// ── 5. golden money parity with the FE algorithm ─────────────────────────────
// Recompute one cell with the FE formula (FNV-1a port) and require an exact match.
function feSeededUnit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) { hash ^= seed.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) / 4294967295;
}
{
  const weightLb = Math.max(0.25, INPUT.weightOz / 16);
  const dimFactor = Math.min(18, (INPUT.dimsL * INPUT.dimsW * INPUT.dimsH) / 1728) * 1.15;
  const seedBase = `${INPUT.orderId}:${INPUT.weightOz}:${INPUT.dimsL}x${INPUT.dimsW}x${INPUT.dimsH}`;
  const jitter = feSeededUnit(`${seedBase}:900001:prepship_test_economy`);
  const expected = Math.round(Math.max(0, 4.65 + 2.75 * jitter + weightLb * 0.72 + dimFactor) * 100) / 100;
  const got = (a[0]!.shipping_amount as { amount: number }).amount;
  check('money matches the FE formula exactly (golden cell)', got === expected, `got ${got}, want ${expected}`);
}

// ── 6-8. getRates gating pins ─────────────────────────────────────────────────
const ratesService = readFileSync('src/services/rates.ts', 'utf8');
check('getRates gates the fixture on the canonical loadClientIsTest authority',
  /await loadClientIsTest\(Number\(resolvedInput\.clientId\)\)/.test(ratesService));
{
  // Scope to the getRates body — loadShippingAutomationRules has earlier call
  // sites in the file; the ordering that matters is inside getRates itself.
  const getRatesAt = ratesService.indexOf('export async function getRates(');
  const gateAt = ratesService.indexOf('buildTestFixtureRates({', getRatesAt);
  const carrierCallAt = ratesService.indexOf('loadShippingAutomationRules()', getRatesAt);
  check('fixture branch sits BEFORE the live-pipeline setup (no carrier call for test clients)',
    getRatesAt > 0 && gateAt > getRatesAt && carrierCallAt > getRatesAt && gateAt < carrierCallAt);
}
{
  const gateStart = ratesService.indexOf('if (resolvedInput.clientId != null && (await loadClientIsTest(');
  const gateEnd = ratesService.indexOf('const automationRules', gateStart);
  const gateBlock = ratesService.slice(gateStart, gateEnd);
  check('fixture result is never written to the rate cache',
    gateStart > 0 && !/insertRateCache|rateCache\)/.test(gateBlock) && /cached: false/.test(gateBlock));
}

if (failures > 0) {
  console.error(`\nFAIL PS-187 backend test-rate fixture guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-187 backend test-rate fixture guard');
