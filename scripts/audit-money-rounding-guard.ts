/**
 * Audit 3.7 / B-8 — canonical backend money-rounding guard.
 *
 * Pure/offline: no DB, providers, labels, notifications, or order mutations.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { roundMoney } from '../src/lib/money';
import { decideShippingLineBilling } from '../src/services/billing-shipping-line';
import { applyCanonicalMarkup } from '../src/services/shipping-workflow/markup-resolver';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

const exactCases: Array<[string, number, number]> = [
  ['positive 1.005 half-cent', 1.005, 1.01],
  ['positive 2.675 half-cent', 2.675, 2.68],
  ['markup float dust at 14.375', 12.5 * 1.15, 14.38],
  ['negative -1.005 half-cent', -1.005, -1.01],
  ['negative -2.675 half-cent', -2.675, -2.68],
  ['negative markup float dust', -(12.5 * 1.15), -14.38],
  ['below half-cent stays down', 1.0049, 1],
  ['above half-cent stays up', 1.0051, 1.01],
];

for (const [name, input, expected] of exactCases) {
  const actual = roundMoney(input);
  check(name, actual === expected, { input, expected, actual });
}

check('non-finite inputs preserve historical zero fallback',
  roundMoney(Number.NaN) === 0 && roundMoney(Infinity) === 0 && roundMoney(-Infinity) === 0);
check('negative zero normalizes to zero', roundMoney(-0) === 0 && !Object.is(roundMoney(-0), -0));

const markup = applyCanonicalMarkup(12.5, { pct: 15, flat: 0 });
const billing = decideShippingLineBilling({
  labelCost: 12.5,
  cShippingRateAmount: null,
  billingMode: 'label_cost',
  isBaselineCarrier: true,
  refUspsRate: 0,
  refUpsRate: 0,
  shippingMarkupPct: 15,
  shippingMarkupFlat: 0,
});
check('quote and invoice share canonical half-cent result',
  markup === 14.38 && billing.billedAmount === markup,
  { markup, billedAmount: billing.billedAmount });

const samplePeriodBytes = JSON.stringify([
  {
    order: 'SAMPLE-1',
    input: {
      labelCost: 12.34,
      cShippingRateAmount: null,
      billingMode: 'label_cost',
      isBaselineCarrier: true,
      refUspsRate: 0,
      refUpsRate: 0,
      shippingMarkupPct: 15,
      shippingMarkupFlat: 0.25,
    },
  },
  {
    order: 'SAMPLE-2',
    input: {
      labelCost: 9.87,
      cShippingRateAmount: 11.23,
      billingMode: 'label_cost',
      isBaselineCarrier: true,
      refUspsRate: 0,
      refUpsRate: 0,
      shippingMarkupPct: 0,
      shippingMarkupFlat: 0,
    },
  },
  {
    order: 'SAMPLE-3',
    input: {
      labelCost: 8.16,
      cShippingRateAmount: null,
      billingMode: 'reference_rate',
      isBaselineCarrier: false,
      refUspsRate: 9.11,
      refUpsRate: 10.22,
      shippingMarkupPct: 0,
      shippingMarkupFlat: 0,
    },
  },
].map(({ order, input }) => {
  const decision = decideShippingLineBilling(input);
  return {
    order,
    unitCost: decision.billedAmount.toFixed(2),
    totalCost: decision.billedAmount.toFixed(2),
    source: decision.source,
    suffix: decision.descriptionSuffix,
  };
}));
const expectedSamplePeriodBytes = '[{"order":"SAMPLE-1","unitCost":"14.44","totalCost":"14.44","source":"label_cost","suffix":" (15% + $0.25)"},{"order":"SAMPLE-2","unitCost":"11.23","totalCost":"11.23","source":"c_shipping_rate","suffix":""},{"order":"SAMPLE-3","unitCost":"9.11","totalCost":"9.11","source":"reference_rate","suffix":""}]';
check('representative billing period export stays byte-identical',
  samplePeriodBytes === expectedSamplePeriodBytes,
  { expectedSamplePeriodBytes, samplePeriodBytes });

const delegatedFiles = [
  'src/services/billing.ts',
  'src/services/billing-box-cost-bulk.ts',
  'src/services/billing-box-cost-by-dims.ts',
  'src/services/billing-box-policy.ts',
  'src/services/billing-hugrab-shipping-rate-override.ts',
  'src/services/billing-invoice-totals.ts',
  'src/services/billing-manual-overrides.ts',
  'src/services/billing-selected-rate-cost.ts',
  'src/services/billing-shipping-line.ts',
  'src/services/billing-storage.ts',
  'src/services/hugrab-billing-shipping-floor.ts',
  'src/services/order-rate-dto.ts',
  'src/services/test-rate-fixture.ts',
  'src/services/shipping-workflow/house-tuple-stamp.ts',
  'src/services/shipping-workflow/markup-resolver.ts',
  'src/services/shipping-workflow/multi-package-label-purchase-boundary.ts',
  'src/services/shipping-workflow/multi-package-shipstation-adapter.ts',
  'src/services/shipping-workflow/parcelguard-backfill.ts',
  'src/services/shipping-workflow/purchase-customer-rate-aliases.ts',
  'src/services/shipping-workflow/rate-money.ts',
  'src/services/shipping-workflow/selected-rate-cost-backfill.ts',
  'src/services/shipping-workflow/shipping-rate-money-normalizer.ts',
] as const;

const localOwnerPattern = /(?:function\s+(?:round2|roundCents|roundMoney|cents)\s*\(|const\s+(?:round2|roundCents|roundMoney)\s*=)/;
for (const path of delegatedFiles) {
  const source = read(path);
  check(`${path} delegates to roundMoney`, source.includes('roundMoney'));
  check(`${path} has no local cent-rounding owner`, !localOwnerPattern.test(source));
}

const canonicalMoneyPath = 'src/lib/money.ts';
const competingMoneyOwners = sourceFiles('src').filter(
  (path) => path !== canonicalMoneyPath && localOwnerPattern.test(read(path)),
);
check('src has one named cent-rounding owner', competingMoneyOwners.length === 0, competingMoneyOwners);

const billingSource = read('src/services/billing.ts');
check('billing amount serialization rounds through owner first',
  /unitCost:\s*roundMoney\(pickPackFee\)\.toFixed\(2\)/.test(billingSource) &&
  /totalCost:\s*roundMoney\(extraCost\)\.toFixed\(2\)/.test(billingSource) &&
  /totalCost:\s*roundMoney\(storage\.amount\)\.toFixed\(2\)/.test(billingSource));

const moneySource = read('src/lib/money.ts');
check('owner documents symmetric half-cent policy and scale-aware tolerance',
  /ties round away from zero/.test(moneySource) &&
  /Number\.EPSILON\s*\*\s*Math\.max\(1, scaled\)/.test(moneySource));

if (failures > 0) {
  console.error(`\nAudit money-rounding guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nAudit money-rounding guard passed.');
