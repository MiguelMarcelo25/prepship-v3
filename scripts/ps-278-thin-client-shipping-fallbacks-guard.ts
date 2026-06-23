/**
 * PS-278 (slice 1) — thin-client shipping fallbacks: the FE owns NO residential authority.
 *
 * residentialForRate feeds buildRateRequestDraftKey's r= bit — a MONEY-PATH decision (which rate is
 * quoted/cached/billed). After PS-276/277 the backend publishes the money-safe verdict on every order
 * DTO (recipient.residentialClassification — ps-276-dto-residential-verdict proves it always resolves),
 * so the FE must FORWARD that verdict and never re-derive the classification from raw provider fields
 * (order.residential / raw.shipTo / sourceResidential). This pins that the FE re-derives nothing — a
 * second owner of a money-path decision would let the FE draft key diverge from the backend fingerprint.
 *
 *   npx tsx scripts/ps-278-thin-client-shipping-fallbacks-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// PS-280: residentialForRate moved to the shared owner web/src/lib/residential-for-rate; OrdersView +
// RateBrowserModal both DELEGATE to it. Pin the forward-only shape at the shared owner + verify delegation.
const ov = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const rule = readFileSync('web/src/lib/residential-for-rate.ts', 'utf8');
const start = rule.indexOf('export function residentialForRate(');
const end = rule.indexOf('\n}', start);
const body = start >= 0 ? rule.slice(start, end) : '';

check('OrdersView delegates residentialForRate to the shared rule',
  /residentialForRate as residentialForRateRule/.test(ov) && /return residentialForRateRule\(order\)/.test(ov));
check('shared residentialForRate rule exists', start >= 0);
check('it FORWARDS the backend verdict (recipient.residentialClassification)',
  /order\?\.residentialClassification \?\? order\?\.canonicalOrder\?\.recipient\?\.residentialClassification/.test(body));
check('FE does NOT re-derive residential from the raw ShipStation source flag (thin client)',
  !/sourceResidential/.test(body));
check('FE does NOT re-derive residential from raw shipTo (thin client)',
  !/raw\?\.shipTo/.test(body) && !/rawShipTo/.test(body));
check('FE does NOT read the legacy merged residential boolean (thin client)',
  !/const merged/.test(body));
check('verdict absent -> money-safe residential default (return true)',
  /return true\s*$/.test(body.trimEnd()));

// ── slice 2: the side-panel preview no longer invents operator-facing money ──
// The SOT branch (getBackendRowMoney markedAmount, pinned by ps-277-panel-reads-sot) is the
// authoritative marked amount and refetches within a tick; the transient preview branch must show a
// pending placeholder, NEVER an ad-hoc shipmentCost + otherCost sum (the raw un-marked carrier cost).
// PS-166/PS-306/PS-258 (Wave 5): the side-panel rate box (incl. this preview
// branch) was extracted VERBATIM from OrdersView into OrdersDetailSidePanel.tsx.
// Re-anchor the preview-branch checks at the new leaf owner.
const panel = readFileSync('web/src/components/Views/OrdersDetailSidePanel.tsx', 'utf8');
const previewStart = panel.indexOf(') : panelPreviewRate ? (');
const previewEnd = panel.indexOf(') : (', previewStart);
const preview = previewStart >= 0 ? panel.slice(previewStart, previewEnd) : '';
check('panel preview branch exists', previewStart >= 0 && previewEnd > previewStart);
check('panel preview no longer reads the raw carrier shipmentCost for operator-facing money',
  !/panelPreviewRate\.shipmentCost/.test(preview));
check('panel preview no longer sums otherCost into operator-facing money',
  !/panelPreviewRate\.otherCost/.test(preview));

check('package.json wires test:ps-278-thin-client-shipping-fallbacks',
  /test:ps-278-thin-client-shipping-fallbacks/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-278 thin-client shipping fallbacks guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-278 thin-client shipping fallbacks guard');
