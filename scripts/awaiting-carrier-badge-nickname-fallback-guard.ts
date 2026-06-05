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

// CarrierBadge exports classifyCarrier and OrdersView imports it.
check(
  'OrdersView imports classifyCarrier from CarrierBadge',
  /import CarrierBadge, \{ classifyCarrier \} from '\.\.\/CarrierBadge'/.test(ordersView),
);

// getCarrierCodeForDisplay (awaiting) falls back to the known-carrier nickname.
const fnStart = ordersView.indexOf('function getCarrierCodeForDisplay(');
const fnEnd = ordersView.indexOf('\nfunction getShipAccountDisplay(', fnStart);
const fnBlock = fnStart >= 0 && fnEnd > fnStart ? ordersView.slice(fnStart, fnEnd) : '';
check('found getCarrierCodeForDisplay', fnBlock.length > 0);
check(
  'awaiting carrier falls back to nickname only for a KNOWN carrier',
  /const nickname = getBestRateCarrierNickname\(order\)/.test(fnBlock) &&
    /classifyCarrier\(nickname\) !== 'other'/.test(fnBlock) &&
    /return nickname/.test(fnBlock),
);

if (failures > 0) {
  console.error(`\nFAIL awaiting carrier badge nickname fallback guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS awaiting carrier badge nickname fallback guard');
