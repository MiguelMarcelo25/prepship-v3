/**
 * PS-164 — FE confirmation/insurance normalizer delegation guard.
 *
 * Proves the frontend delegates to the canonical alias owner (src/lib/shipping-options) instead of
 * hand-rolling its own maps, and pins the DJ-approved money-path behavior (2026-06-10):
 *   - an UNKNOWN insurance provider resolves to 'none' (no insurance), NOT 'carrier'.
 *   - 'shipsurance' / 'parcelguard' (incl. parcel_guard / "parcel guard") survive.
 *   - confirmation aliases normalize to the canonical set (the 5 UI values are unchanged).
 *
 *   npx tsx scripts/ps-164-fe-normalizer-delegation-guard.ts
 */
import { readFileSync } from 'node:fs';
import { normalizeConfirmation, normalizeInsurance } from '../src/lib/shipping-options';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  } else { console.log(`ok   ${name}`); }
}
function checkBool(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); } else { console.log(`ok   ${name}`); }
}

// ── 1) Confirmation: 5 UI values unchanged; aliases honored; unknown/empty -> none ──
check('confirmation: none', normalizeConfirmation('none'), 'none');
check('confirmation: signature (UI value unchanged)', normalizeConfirmation('signature'), 'signature');
check('confirmation: adult_signature (UI value unchanged)', normalizeConfirmation('adult_signature'), 'adult_signature');
check('confirmation: delivery_confirmation alias -> delivery', normalizeConfirmation('delivery_confirmation'), 'delivery');
check('confirmation: empty -> none', normalizeConfirmation(''), 'none');
check('confirmation: garbage -> none', normalizeConfirmation('garbage'), 'none');

// ── 2) Insurance money-path (the DJ-approved behavior change) ──
check('insurance: carrier + value preserved',
  normalizeInsurance({ insuranceProvider: 'carrier', insuredValue: 100 }), { insuranceProvider: 'carrier', insuredValue: 100 });
check('insurance: shipsurance preserved',
  normalizeInsurance({ insuranceProvider: 'shipsurance', insuredValue: 50 }), { insuranceProvider: 'shipsurance', insuredValue: 50 });
check('insurance: "parcel guard" alias -> parcelguard',
  normalizeInsurance({ insuranceProvider: 'parcel guard', insuredValue: 75 }), { insuranceProvider: 'parcelguard', insuredValue: 75 });
check('insurance: provider/shipstation -> carrier',
  normalizeInsurance({ insuranceProvider: 'shipstation', insuredValue: 25 }), { insuranceProvider: 'carrier', insuredValue: 25 });
check('insurance: UNKNOWN provider -> none (was carrier — money-path fix)',
  normalizeInsurance({ insuranceProvider: 'someunknownco', insuredValue: 100 }), { insuranceProvider: 'none', insuredValue: null });
check('insurance: "no" -> none (was carrier)',
  normalizeInsurance({ insuranceProvider: 'no', insuredValue: 100 }), { insuranceProvider: 'none', insuredValue: null });
check('insurance: zero value -> none',
  normalizeInsurance({ insuranceProvider: 'carrier', insuredValue: 0 }), { insuranceProvider: 'none', insuredValue: null });
check('insurance: none -> none',
  normalizeInsurance({ insuranceProvider: 'none', insuredValue: 100 }), { insuranceProvider: 'none', insuredValue: null });

// ── 3) OrdersView delegates (no hand-rolled maps) ──
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
checkBool('OrdersView imports the canonical normalizers',
  /import \{ normalizeConfirmation, normalizeInsurance \} from '\.\.\/\.\.\/\.\.\/\.\.\/src\/lib\/shipping-options'/.test(ordersView));
checkBool('OrdersView confirmation delegates to canonical',
  /function normalizeConfirmationForRates[\s\S]{0,200}?return normalizeConfirmation\(value\)/.test(ordersView));
checkBool('OrdersView insurance delegates to canonical',
  /function normalizeInsuranceForRates[\s\S]{0,260}?return normalizeInsurance\(\{ insuranceProvider: provider, insuredValue: value \}\)/.test(ordersView));
checkBool('OrdersView no longer hand-rolls the insurance carrier-fallback ternary',
  !/everything else maps to carrier insurance/.test(ordersView) &&
  !/insuranceProvider === 'shipsurance'\s*\n\s*\?\s*'shipsurance'/.test(ordersView));

// ── 4) RateBrowserModal delegates (no inline passthrough) ──
const rateBrowser = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
checkBool('RateBrowserModal imports the canonical normalizers',
  /import \{ normalizeConfirmation, normalizeInsurance \} from '\.\.\/\.\.\/\.\.\/src\/lib\/shipping-options'/.test(rateBrowser));
checkBool('RateBrowserModal confirmation delegates to canonical then clamps to the 5 dropdown values',
  /const normalized = normalizeConfirmation\(value\)/.test(rateBrowser) &&
  /CONFIRMATION_OPTIONS\.some\(\(o\) => o\.value === normalized\)/.test(rateBrowser));
checkBool('RateBrowserModal browse-insurance delegates to canonical',
  /normalizeInsurance\(\{ insuranceProvider: effectiveInsuranceProvider, insuredValue: effectiveInsuredValue \}\)/.test(rateBrowser));
checkBool('RateBrowserModal currentAppliedInsurance delegates to canonical',
  /return normalizeInsurance\(\{ insuranceProvider, insuredValue \}\)/.test(rateBrowser));
checkBool('RateBrowserModal no longer passes the raw provider through inline',
  !/effectiveInsuranceProvider !== 'none' && Number\(effectiveInsuredValue\) > 0\s*\n\s*\?\s*effectiveInsuranceProvider/.test(rateBrowser));

if (failures > 0) {
  console.error(`\nFAIL PS-164 FE normalizer delegation guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-164 FE normalizer delegation guard');
