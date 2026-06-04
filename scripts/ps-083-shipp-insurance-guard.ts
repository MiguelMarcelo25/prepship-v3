/**
 * PS-083 Guard — Shipp declares insured value via packageLineItems[].customsValue.
 *
 * Shipp's API now accepts a declared value on the PackageLineItem (customsValue).
 * Previously our connector hard-coded `insurance: false` (dropping Shipp for any
 * insured order, e.g. HUGRAB $100) and `customsValue.amount: 0`. This guard locks
 * the two corrected behaviours:
 *   1. Shipp now PASSES the shipping-option gate when insurance is requested.
 *   2. The declared value mapping (insuranceProvider/insuredValue -> customsValue
 *      amount) is correct and safe (0 when not insured / invalid).
 *
 *   npx tsx scripts/ps-083-shipp-insurance-guard.ts
 *
 * Read-only: no DB, no carrier IO, never buys a label. Pure logic only.
 */
import { shippDeclaredValue } from '../src/connectors/carrier/shipp.js';
import { assertUnsupportedShippingOptions } from '../src/connectors/carrier/shipping-option-support.js';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}
function expectThrows(name: string, fn: () => unknown, fragment: string) {
  try {
    fn();
    failures += 1;
    console.error(`FAIL ${name}: expected a throw, none happened`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(fragment)) {
      console.log(`ok   ${name}`);
    } else {
      failures += 1;
      console.error(`FAIL ${name}: threw "${message}", expected to include "${fragment}"`);
    }
  }
}
function expectNoThrow(name: string, fn: () => unknown) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: unexpected throw "${err instanceof Error ? err.message : String(err)}"`);
  }
}

// ── Declared-value mapping (insuredValue -> customsValue.amount) ──────────────
check('insured carrier $100 => declares 100', shippDeclaredValue({ insuranceProvider: 'carrier', insuredValue: 100 }), 100);
check('insured carrier $49.95 => declares 49.95', shippDeclaredValue({ insuranceProvider: 'carrier', insuredValue: 49.95 }), 49.95);
check('no insurance => declares 0', shippDeclaredValue({ insuranceProvider: 'none', insuredValue: 100 }), 0);
check('insured but $0 => declares 0', shippDeclaredValue({ insuranceProvider: 'carrier', insuredValue: 0 }), 0);
check('insured but null value => declares 0', shippDeclaredValue({ insuranceProvider: 'carrier', insuredValue: null }), 0);
check('insured but negative => declares 0', shippDeclaredValue({ insuranceProvider: 'carrier', insuredValue: -5 }), 0);
check('empty options => declares 0', shippDeclaredValue({}), 0);

// ── The gate: Shipp now ACCEPTS an insured order (insurance: true) ────────────
expectNoThrow('insured order passes the Shipp gate (insurance: true)', () =>
  assertUnsupportedShippingOptions(
    'Shipp',
    { insuranceProvider: 'carrier', insuredValue: 100 },
    { confirmation: ['delivery', 'none'], insurance: true },
  ),
);

// Regression doc: with insurance disabled, the gate still rejects (proves the
// gate is real and we genuinely flipped Shipp, not weakened the gate globally).
expectThrows(
  'gate still rejects insurance when a carrier opts out',
  () =>
    assertUnsupportedShippingOptions(
      'Shipp',
      { insuranceProvider: 'carrier', insuredValue: 100 },
      { confirmation: ['delivery', 'none'], insurance: false },
    ),
  'insurance is not supported by Shipp',
);

// Confirmation support is unchanged: Shipp only supports delivery/none.
expectThrows(
  'signature confirmation is still rejected for Shipp',
  () =>
    assertUnsupportedShippingOptions(
      'Shipp',
      { confirmation: 'signature', insuranceProvider: 'none' },
      { confirmation: ['delivery', 'none'], insurance: true },
    ),
  'is not supported by Shipp',
);

// A non-insured order still passes cleanly with insurance enabled.
expectNoThrow('non-insured order still passes the gate', () =>
  assertUnsupportedShippingOptions(
    'Shipp',
    { confirmation: 'delivery', insuranceProvider: 'none' },
    { confirmation: ['delivery', 'none'], insurance: true },
  ),
);

if (failures > 0) {
  console.error(`\nFAIL PS-083 Shipp insurance guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-083 Shipp insurance guard');
