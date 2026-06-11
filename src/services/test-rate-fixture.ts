/**
 * PS-187 — canonical backend test-rate fixture.
 *
 * Test clients (clients.is_test, the PS-186 authority) get DETERMINISTIC fixture
 * rates from the backend instead of real ShipStation/direct-carrier quotes. This
 * is the canonical owner the FE's buildTestRatesForShipment/buildTestMockRate
 * duplicated client-side; the FE copies are deleted once this is verified live
 * (replacement-first per ARCHITECTURE.md).
 *
 * The seeded algorithm is a faithful port of the FE generator (FNV-1a jitter,
 * same accounts/templates/money formula) so fixture money for an existing test
 * order matches what operators already saw — switching owners changes WHERE the
 * rates come from, not WHAT they say.
 *
 * Every fixture rate carries `testFixture: true` + `mocked: true` and the
 * `prepship_test` carrier code, and uses synthetic provider ids (900001-900005,
 * the same ids the FE table used) that classifyLabelEndpoint never routes to a
 * real carrier. Purchases on test clients are forced into the mock-label branch
 * by the PS-186 test-label policy regardless — fixtures never buy postage.
 */

export const TEST_FIXTURE_CARRIER_CODE = 'prepship_test';
export const TEST_FIXTURE_SERVICE_CODE = 'prepship_test_standard';

const TEST_FIXTURE_ACCOUNTS = [
  { shippingProviderId: 900001, label: 'PrepShip Test Standard' },
  { shippingProviderId: 900002, label: 'PrepShip Test Saver' },
  { shippingProviderId: 900003, label: 'PrepShip Test Priority' },
  { shippingProviderId: 900004, label: 'PrepShip Test Express' },
  { shippingProviderId: 900005, label: 'PrepShip Test Local' },
] as const;

const TEST_FIXTURE_SERVICE_TEMPLATES = [
  { code: 'prepship_test_economy', name: 'PrepShip Test Economy', base: 4.65, spread: 2.75, perLb: 0.72, days: 5 },
  { code: TEST_FIXTURE_SERVICE_CODE, name: 'PrepShip Test Standard', base: 7.25, spread: 3.8, perLb: 0.96, days: 3 },
  { code: 'prepship_test_priority', name: 'PrepShip Test Priority', base: 13.9, spread: 6.75, perLb: 1.28, days: 2 },
] as const;

// FNV-1a over the seed string → unit interval. Byte-for-byte the FE algorithm
// (seededTestUnit) so existing test orders keep their familiar fixture money.
function seededUnit(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function roundMoney(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

export type TestFixtureRateInput = {
  orderId: number | string | null | undefined;
  weightOz: number;
  dimsL: number;
  dimsW: number;
  dimsH: number;
};

/**
 * Deterministic fixture rates in the backend's ShipStation-normalized Rate shape
 * (snake_case money blocks) so the entire downstream pipeline — markups, best-rate
 * pick, /browse selectedRateKey + snapshot stamping, FE translation — treats them
 * exactly like real rates. Same input → same output, no Date/randomness.
 */
export function buildTestFixtureRates(input: TestFixtureRateInput): Array<Record<string, unknown>> {
  const weightOz = Number.isFinite(input.weightOz) && input.weightOz > 0 ? input.weightOz : 1;
  const dims = {
    length: Number.isFinite(input.dimsL) && input.dimsL > 0 ? input.dimsL : 0,
    width: Number.isFinite(input.dimsW) && input.dimsW > 0 ? input.dimsW : 0,
    height: Number.isFinite(input.dimsH) && input.dimsH > 0 ? input.dimsH : 0,
  };
  const weightLb = Math.max(0.25, weightOz / 16);
  const cubicInches = Math.max(0, dims.length * dims.width * dims.height);
  const dimFactor = Math.min(18, cubicInches / 1728) * 1.15;
  const seedBase = `${input.orderId ?? 'no-order'}:${weightOz}:${dims.length}x${dims.width}x${dims.height}`;

  return TEST_FIXTURE_ACCOUNTS.flatMap((account) =>
    TEST_FIXTURE_SERVICE_TEMPLATES.map((template, templateIndex) => {
      const jitter = seededUnit(`${seedBase}:${account.shippingProviderId}:${template.code}`);
      const surchargeSeed = seededUnit(`${seedBase}:fuel:${account.shippingProviderId}:${templateIndex}`);
      const shipmentCost = roundMoney(template.base + template.spread * jitter + weightLb * template.perLb + dimFactor);
      const otherCost = roundMoney(surchargeSeed > 0.72 ? 0.55 + surchargeSeed * 1.45 : 0);
      return {
        rate_id: `test-fixture:${seedBase}:${account.shippingProviderId}:${template.code}`,
        rate_type: 'check',
        carrier_id: `se-${account.shippingProviderId}`,
        carrier_code: TEST_FIXTURE_CARRIER_CODE,
        carrier_nickname: account.label,
        service_type: template.name,
        service_code: template.code,
        shipping_amount: { currency: 'usd', amount: shipmentCost },
        other_amount: { currency: 'usd', amount: otherCost },
        delivery_days: template.days,
        // Markers: never confusable with a real quote, and the test-label policy
        // (PS-186) independently forces mock labels for these clients anyway.
        testFixture: true,
        mocked: true,
      };
    }),
  );
}
