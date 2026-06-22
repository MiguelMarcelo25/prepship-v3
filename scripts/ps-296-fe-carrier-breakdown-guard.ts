/**
 * PS-296 (FE) guard — BillingView consumes the backend carrier/account margin breakdown.
 *
 * The PS-296 audit found the carrier rollup (analytics.carriers[]) was FETCHED but
 * DISCARDED — BillingView only kept .summary. This guard pins the first consumer: the
 * "Margin by carrier / account" breakdown table, stored from marginAnalytics.carriers and
 * rendered read-only from the backend fields (no FE recompute). Fails if the consumption
 * is removed.
 *
 * Offline/static only.
 */
import { readFileSync } from 'node:fs';

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
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

const billing = read('web/src/components/Views/BillingView.tsx');

check('BillingView types the carrier breakdown row', /type ShippingMarginCarrierDto = \{/.test(billing));
check('BillingView holds carrier breakdown state', /shippingMarginCarriers.*useState<ShippingMarginCarrierDto\[\]>/.test(billing));
check('BillingView stores the backend analytics.carriers[] (was discarded)',
  /setShippingMarginCarriers\(marginAnalytics\?\.carriers \?\? \[\]\)/.test(billing));
check('BillingView resets carriers on error', /setShippingMarginCarriers\(\[\]\)/.test(billing));
check('BillingView renders the carrier breakdown table',
  /Margin by carrier \/ account/.test(billing) &&
  /shippingMarginCarriers\.map\(/.test(billing));
check('the table reads backend margin fields (no FE recompute)',
  /carrier\.marginTotal/.test(billing) &&
  /carrier\.negativeMarginCount/.test(billing) &&
  /carrier\.marginPct/.test(billing));

if (failures > 0) {
  console.error(`\nPS-296 FE carrier breakdown guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-296 FE carrier breakdown guard passed.');
