/**
 * PS-165 guard — carrier/service DISPLAY precedence (extracted VERBATIM from OrdersView into
 * web/src/components/Views/order-shipping-display.ts). Pure logic: no DB, no network, no React.
 *
 * Pins the per-status precedence so the Orders carrier/service columns render identically after the
 * extraction — especially the SHIPPED/CANCELLED rows (locked surface): awaiting prefers the current
 * best rate, while shipped/history prefers the canonical (frozen) shipping metadata.
 *
 * Per user override `unlock shipped data` on 2026-06-10: this pins the shipped/cancelled display
 * behavior so the extraction cannot weaken it.
 *
 *   npx tsx scripts/ps-165-order-shipping-display-guard.ts
 */
import {
  resolveDisplayCarrierCode,
  resolveDisplayServiceCode,
  resolveDisplayShipAccount,
  DISPLAY_TEST_CARRIER_CODE,
  DISPLAY_TEST_SHIPPING_ACCOUNT_LABEL,
} from '../web/src/components/Views/order-shipping-display';

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

const blankCarrier = {
  isTest: false,
  isAwaiting: false,
  bestRateCarrierCode: null,
  canonicalCarrierCode: null,
  selectedRateCarrierCode: null,
  bestRateNickname: null,
  bestRateNicknameIsKnownCarrier: false,
};

// --- carrier code: test order short-circuits everything ---
check('test order -> TEST_CARRIER_CODE', resolveDisplayCarrierCode({ ...blankCarrier, isTest: true, isAwaiting: true, bestRateCarrierCode: 'ups' }), DISPLAY_TEST_CARRIER_CODE);

// --- carrier code: awaiting prefers best rate ---
check('awaiting -> bestRate wins', resolveDisplayCarrierCode({ ...blankCarrier, isAwaiting: true, bestRateCarrierCode: 'ups', canonicalCarrierCode: 'fedex', selectedRateCarrierCode: 'usps' }), 'ups');
check('awaiting -> falls to canonical', resolveDisplayCarrierCode({ ...blankCarrier, isAwaiting: true, canonicalCarrierCode: 'fedex', selectedRateCarrierCode: 'usps' }), 'fedex');
check('awaiting -> falls to selected', resolveDisplayCarrierCode({ ...blankCarrier, isAwaiting: true, selectedRateCarrierCode: 'usps' }), 'usps');
check('awaiting blank -> KNOWN-carrier nickname', resolveDisplayCarrierCode({ ...blankCarrier, isAwaiting: true, bestRateNickname: 'UPS by SS', bestRateNicknameIsKnownCarrier: true }), 'UPS by SS');
check('awaiting blank -> UNKNOWN nickname not used', resolveDisplayCarrierCode({ ...blankCarrier, isAwaiting: true, bestRateNickname: 'ORI Account', bestRateNicknameIsKnownCarrier: false }), null);

// --- carrier code: shipped/history prefers CANONICAL (the locked-surface invariant) ---
check('shipped -> canonical wins over bestRate', resolveDisplayCarrierCode({ ...blankCarrier, isAwaiting: false, bestRateCarrierCode: 'ups', canonicalCarrierCode: 'fedex', selectedRateCarrierCode: 'usps' }), 'fedex');
check('shipped -> no canonical falls to selected', resolveDisplayCarrierCode({ ...blankCarrier, isAwaiting: false, bestRateCarrierCode: 'ups', selectedRateCarrierCode: 'usps' }), 'usps');
check('shipped -> only bestRate', resolveDisplayCarrierCode({ ...blankCarrier, isAwaiting: false, bestRateCarrierCode: 'ups' }), 'ups');
// Same inputs, opposite status → opposite winner. Proves per-status precedence is intact.
const ambiguous = { ...blankCarrier, bestRateCarrierCode: 'ups', canonicalCarrierCode: 'fedex' };
check('per-status: awaiting=ups vs shipped=fedex (same inputs)', [
  resolveDisplayCarrierCode({ ...ambiguous, isAwaiting: true }),
  resolveDisplayCarrierCode({ ...ambiguous, isAwaiting: false }),
], ['ups', 'fedex']);
// Shipped nickname is NEVER used (nickname branch is awaiting-only).
check('shipped blank -> nickname ignored -> null', resolveDisplayCarrierCode({ ...blankCarrier, isAwaiting: false, bestRateNickname: 'UPS by SS', bestRateNicknameIsKnownCarrier: true }), null);

// --- service code ---
check('awaiting + bestRate service wins', resolveDisplayServiceCode({ isAwaiting: true, hasBestRate: true, bestRateServiceCode: 'ups_ground', canonicalServiceCode: 'fedex_home' }), 'ups_ground');
check('awaiting + blank bestRate service -> canonical', resolveDisplayServiceCode({ isAwaiting: true, hasBestRate: true, bestRateServiceCode: null, canonicalServiceCode: 'fedex_home' }), 'fedex_home');
check('shipped -> canonical wins over bestRate', resolveDisplayServiceCode({ isAwaiting: false, hasBestRate: true, bestRateServiceCode: 'ups_ground', canonicalServiceCode: 'fedex_home' }), 'fedex_home');
check('shipped -> no canonical falls to bestRate', resolveDisplayServiceCode({ isAwaiting: false, hasBestRate: true, bestRateServiceCode: 'ups_ground', canonicalServiceCode: null }), 'ups_ground');
check('no bestRate -> canonical', resolveDisplayServiceCode({ isAwaiting: true, hasBestRate: false, bestRateServiceCode: null, canonicalServiceCode: 'fedex_home' }), 'fedex_home');
check('nothing -> null', resolveDisplayServiceCode({ isAwaiting: true, hasBestRate: false, bestRateServiceCode: null, canonicalServiceCode: null }), null);

// --- shipping-account display precedence (PS-165 part 2 — first-non-null cascade) ---
const acct = {
  isTest: false,
  awaitingBestRateNickname: null,
  canonicalNickname: null,
  selectedNickname: null,
  v2AccountNickname: null,
  hasSelectedRate: false,
  labelAccountLabel: null,
  bestRateNickname: null,
  carrierCodeFallback: null,
};
check('account: test order -> TEST label', resolveDisplayShipAccount({ ...acct, isTest: true, awaitingBestRateNickname: 'X' }), DISPLAY_TEST_SHIPPING_ACCOUNT_LABEL);
check('account: awaiting best-rate nickname wins', resolveDisplayShipAccount({ ...acct, awaitingBestRateNickname: 'ROCEL', canonicalNickname: 'Chase', selectedNickname: 'Sel' }), 'ROCEL');
check('account: falls to canonical', resolveDisplayShipAccount({ ...acct, canonicalNickname: 'Chase', selectedNickname: 'Sel' }), 'Chase');
check('account: falls to selected', resolveDisplayShipAccount({ ...acct, selectedNickname: 'Sel', v2AccountNickname: 'V2' }), 'Sel');
check('account: falls to v2 carrier-cache account', resolveDisplayShipAccount({ ...acct, v2AccountNickname: 'GG6381' }), 'GG6381');
// PS-273 (reader honesty): live/persisted label-account truth now beats the generic 'External'
// static guess, so a real label account wins even when a selected rate exists.
check('account: live label account wins over External (PS-273)', resolveDisplayShipAccount({ ...acct, hasSelectedRate: true, labelAccountLabel: 'L' }), 'L');
check('account: selectedRate present, NO live label/brokered/v2 -> External (preserved)', resolveDisplayShipAccount({ ...acct, hasSelectedRate: true }), 'External');
// PS-273 (#1587): an un-backfilled Shipp-brokered row (shipp_* service) renders "Shipp", NOT the
// fabricated direct UPS account the static registry would otherwise return.
check('account: Shipp-brokered row -> "Shipp" not fabricated direct account (PS-273)', resolveDisplayShipAccount({ ...acct, hasSelectedRate: true, brokeredServiceCode: 'shipp_ups_ground', v2AccountNickname: 'GG6381' }), 'Shipp');
check('account: label account when no selectedRate', resolveDisplayShipAccount({ ...acct, labelAccountLabel: 'UPS by SS', bestRateNickname: 'BR' }), 'UPS by SS');
check('account: best-rate nickname fallback', resolveDisplayShipAccount({ ...acct, bestRateNickname: 'BR', carrierCodeFallback: 'UPS' }), 'BR');
check('account: formatted carrier code is the final fallback', resolveDisplayShipAccount({ ...acct, carrierCodeFallback: 'UPS' }), 'UPS');
check('account: nothing -> null', resolveDisplayShipAccount(acct), null);

if (failures > 0) {
  console.error(`\nFAIL PS-165 order shipping display guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-165 order shipping display guard');
