/**
 * Guard: the awaiting Carrier column resolves direct-carrier (EasyPost / Shipp)
 * rates to a carrier badge instead of the empty "—" box.
 *
 * Aggregator best rates can carry a carrier NICKNAME ("EasyPost Carrier" /
 * "Shipp Carrier") but leave carrierCode blank, so getCarrierCodeForDisplay
 * returned empty and CarrierBadge rendered its "—" placeholder — even though the
 * row is fully rated (the Shipping Account column shows the carrier). The Carrier
 * cell now falls back to the nickname, but ONLY when it maps to a KNOWN carrier
 * so generic account names (e.g. "ORI Account") don't leak into the column.
 */
import { readFileSync } from 'node:fs';
import { classifyCarrier } from '../web/src/components/CarrierBadge';

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// classifyCarrier maps aggregator nicknames to real carriers, generic ones to 'other'.
check("classifyCarrier('EasyPost Carrier') === 'easypost'", classifyCarrier('EasyPost Carrier') === 'easypost');
check("classifyCarrier('Shipp Carrier') === 'shipp'", classifyCarrier('Shipp Carrier') === 'shipp');
check("classifyCarrier('ORI Account') === 'other'", classifyCarrier('ORI Account') === 'other');

// STALE-PIN RE-ANCHOR (PS-166 Wave 2a; pre-existing red since PS-165): the
// old pins held getCarrierCodeForDisplay's pre-PS-165 INLINE body
// (`const nickname = …; return nickname`). PS-165 moved the precedence —
// including the known-carrier nickname fallback — into the canonical
// resolveDisplayCarrierCode (order-shipping-display, behaviorally certified
// by test:ps-165-order-shipping-display), and getCarrierCodeForDisplay
// DELEGATES, feeding it `bestRateNicknameIsKnownCarrier` from
// classifyCarrier. PS-166 then moved the delegating function verbatim to
// orders-display-state. Pin the LIVE shape: the module classifies the
// nickname via classifyCarrier and hands the fallback decision to the
// canonical resolver.
const displayState = readFileSync('web/src/components/Views/orders-display-state.ts', 'utf8');
check(
  'display-state module imports classifyCarrier from CarrierBadge',
  /import \{ classifyCarrier \} from '\.\.\/CarrierBadge'/.test(displayState),
);

const fnStart = displayState.indexOf('export function getCarrierCodeForDisplay(');
const fnEnd = displayState.indexOf('\nexport function getShipAccountDisplay(', fnStart);
const fnBlock = fnStart >= 0 && fnEnd > fnStart ? displayState.slice(fnStart, fnEnd) : '';
check('found getCarrierCodeForDisplay', fnBlock.length > 0);
check(
  'awaiting carrier nickname fallback is KNOWN-carrier-gated through the canonical resolver',
  /getBestRateCarrierNickname\(order\)/.test(fnBlock) &&
    /classifyCarrier\(bestRateNickname\) !== 'other'/.test(fnBlock) &&
    /bestRateNicknameIsKnownCarrier/.test(fnBlock) &&
    /resolveDisplayCarrierCode\(\{/.test(fnBlock),
);

if (failures > 0) {
  console.error(`\nFAIL awaiting carrier badge nickname fallback guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS awaiting carrier badge nickname fallback guard');
