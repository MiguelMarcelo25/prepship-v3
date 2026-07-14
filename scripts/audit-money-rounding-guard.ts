/**
 * Audit 3.7 / B-8 — canonical backend money-rounding guard.
 *
 * Pure/offline: no DB, providers, labels, notifications, or order mutations.
 */
import { readFileSync } from 'node:fs';
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
  'src/services/shipping-workflow/markup-resolver.ts',
  'src/services/shipping-workflow/rate-money.ts',
] as const;

const localOwnerPattern = /function\s+(?:round2|roundCents|roundMoney)\s*\(/;
for (const path of delegatedFiles) {
  const source = read(path);
  check(`${path} delegates to roundMoney`, source.includes('roundMoney'));
  check(`${path} has no local cent-rounding owner`, !localOwnerPattern.test(source));
}

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
