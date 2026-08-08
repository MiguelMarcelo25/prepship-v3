/**
 * PS-494 customs country-of-origin guard.
 *
 * Offline: the REAL resolver. No provider, no postage, no production.
 *
 * `src/connectors/carrier/shipp.ts` hardcoded `countryOfManufacture: 'US'` on every quote
 * and label sent to the Shipp broker — the only occurrence of that field in the repo, no
 * override, no consumer.
 *
 * DJ confirmed 2026-08-07 that Dr Prepper's own goods ARE US-manufactured, and separately
 * that the non-US values recorded against client goods are correct. Both are true because
 * PrepShip is a 3PL: country of origin is a property of the ITEM being shipped, not of the
 * business. Of the 333 customs line items ShipStation has recorded, 311 are US, 21 KR and
 * 1 CN — 22 line items across 14 orders (Korean cosmetics, Korean consumer electronics,
 * Korean ramen, a Chinese children's book series), and 13 of those 14 shipped to Canada.
 *
 * So the constant was right for most items and wrong for a measured 6.6%, in the direction
 * that matters: understating foreign origin on cross-border shipments.
 *
 * The data was already there and unread — `order-raw-payload-policy.ts` retains
 * `internationalOptions` on purpose, `countryOfOrigin` is populated on 333 of 333 items,
 * and before this the only reference to that blob outside the retention list was a guard.
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

const {
  resolveCustomsOrigin,
  customsItemsFromOrderRaw,
  resolveOrderCustomsOrigin,
  singleCustomsOriginOrNull,
  decideDeclaredOrigin,
} = await import('../src/services/customs-origin');

// ── the resolution rule ────────────────────────────────────────────────────
check('a carton whose items all agree resolves to that origin',
  JSON.stringify(resolveCustomsOrigin([{ countryOfOrigin: 'US' }, { countryOfOrigin: 'US' }]))
  === JSON.stringify({ kind: 'single', country: 'US' }));
check('a KR-only carton resolves to KR, not the old constant',
  JSON.stringify(resolveCustomsOrigin([{ countryOfOrigin: 'KR' }]))
  === JSON.stringify({ kind: 'single', country: 'KR' }),
  resolveCustomsOrigin([{ countryOfOrigin: 'KR' }]));
check('lowercase provider values normalize',
  JSON.stringify(resolveCustomsOrigin([{ countryOfOrigin: 'kr' }]))
  === JSON.stringify({ kind: 'single', country: 'KR' }));

// THE assertion. A real carton can mix US and KR goods, and the Shipp request carries ONE
// synthetic package line item — one slot for one origin. Reporting `mixed` rather than
// silently picking a winner is what keeps that limitation visible.
{
  const mixed = resolveCustomsOrigin([{ countryOfOrigin: 'US' }, { countryOfOrigin: 'KR' }]);
  check('a MIXED carton is reported as mixed, never silently resolved to one origin',
    mixed.kind === 'mixed', mixed);
  check('the mixed set is sorted and complete, for the eventual per-item builder',
    mixed.kind === 'mixed' && mixed.countries.join(',') === 'KR,US', mixed);
}

// Partial records must not erase what the rest of the carton agrees on: 4 of the 333
// recorded items carry an origin but no description and no HS code.
check('items with no usable origin are ignored, not treated as a disagreement',
  JSON.stringify(resolveCustomsOrigin([
    { countryOfOrigin: 'KR' }, { countryOfOrigin: '' }, {}, { countryOfOrigin: null },
  ])) === JSON.stringify({ kind: 'single', country: 'KR' }));
for (const junk of ['N/A', '-', 'USA', '1', 'United States']) {
  check(`${JSON.stringify(junk)} is not a usable ISO-2 origin`,
    resolveCustomsOrigin([{ countryOfOrigin: junk }]).kind === 'unknown');
}
for (const empty of [null, undefined, []]) {
  check(`${JSON.stringify(empty)} customs items resolve to unknown`,
    resolveCustomsOrigin(empty as never).kind === 'unknown');
}

// ── reading the retained payload ───────────────────────────────────────────
const order = { raw: { internationalOptions: { customsItems: [{ countryOfOrigin: 'CN' }] } } };
check('customs items are read from the retained internationalOptions blob',
  customsItemsFromOrderRaw(order.raw).length === 1);
check('an order resolves end to end from its retained payload',
  JSON.stringify(resolveOrderCustomsOrigin(order)) === JSON.stringify({ kind: 'single', country: 'CN' }));
for (const shape of [
  {}, { internationalOptions: {} }, { internationalOptions: { customsItems: 'nope' } },
  { internationalOptions: { customsItems: [null, 3] } },
]) {
  check(`a malformed payload ${JSON.stringify(shape).slice(0, 46)} does not throw`,
    resolveCustomsOrigin(customsItemsFromOrderRaw(shape)).kind === 'unknown');
}
check('a null order resolves unknown rather than throwing',
  resolveOrderCustomsOrigin(null).kind === 'unknown');

// ── what the backend hands the connector ───────────────────────────────────
check('a resolved origin is passed as a fact',
  singleCustomsOriginOrNull({ kind: 'single', country: 'KR' }) === 'KR');
check('a MIXED carton is passed as an explicit ABSENCE, not a guess',
  singleCustomsOriginOrNull({ kind: 'mixed', countries: ['KR', 'US'] }) === null);
check('an unknown carton is passed as an explicit absence',
  singleCustomsOriginOrNull({ kind: 'unknown' }) === null);

// ── the declaration decision ───────────────────────────────────────────────
// PS-494 correction. These three checks used to assert the OPPOSITE: that a mixed carton
// and an unknown origin both fell back to the operator default or 'US'. The audit's finding
// was that pinning that behaviour made the guard approve the defect instead of catching it
// — the fallback WAS the guessed declaration this card exists to remove. The rule now turns
// on whether the field is really a customs declaration, so the checks turn with it.
check('a resolved origin beats the configured default',
  (() => { const d = decideDeclaredOrigin({ resolution: { kind: 'single', country: 'KR' }, destination: 'Domestic', configuredDefault: 'US' });
    return d.kind === 'declare' && d.country === 'KR'; })());
check('a mixed carton REFUSES — a fallback here would be a guessed declaration',
  decideDeclaredOrigin({ resolution: { kind: 'mixed', countries: ['KR', 'US'] }, destination: 'Domestic', configuredDefault: 'CA' }).kind === 'refuse');
check('unknown + non-domestic REFUSES rather than asserting US',
  decideDeclaredOrigin({ resolution: { kind: 'unknown' }, destination: 'International' }).kind === 'refuse'
  && decideDeclaredOrigin({ resolution: { kind: 'unknown' }, destination: 'Needs Review' }).kind === 'refuse');
check('unknown + DOMESTIC still declares a default, but as one explicit named branch',
  (() => { const d = decideDeclaredOrigin({ resolution: { kind: 'unknown' }, destination: 'Domestic' });
    return d.kind === 'declare' && d.country === 'US' && d.basis === 'domestic_default'; })());

// ── placement: the connector no longer decides ─────────────────────────────
const shipp = readFileSync('src/connectors/carrier/shipp.ts', 'utf8').replace(/\r\n/g, '\n');
const direct = readFileSync('src/services/labels-direct.ts', 'utf8').replace(/\r\n/g, '\n');
const labels = readFileSync('src/services/labels.ts', 'utf8').replace(/\r\n/g, '\n');
const settings = readFileSync('web/src/components/Settings/CarrierIntegrationsCard.tsx', 'utf8').replace(/\r\n/g, '\n');
// Comments quote the old constant to explain the fix; only executable code counts.
const shippCode = shipp
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

check('the connector no longer hardcodes an origin',
  !/countryOfManufacture:\s*'US'/.test(shippCode),
  'a constant cannot state a per-item customs fact');
check('the connector applies the resolved value',
  /countryOfManufacture: shippCountryOfManufacture\(input, creds\)/.test(shippCode));
check('the backend resolves the origin and threads it through the direct-label args',
  /const declaredShippOrigin = assertDeclarableOrigin\(\{/.test(labels)
  && /countryOfManufacture: declaredShippOrigin/.test(labels));
// PS-494 correction: the label path must REFUSE an undeclarable origin before the provider
// call, not hand the connector an absence and let it default.
check('the label path refuses an undeclarable origin before any provider call',
  !/singleCustomsOriginOrNull/.test(labels));
check('the direct-label orchestrator forwards it to the connector input',
  /countryOfManufacture: args\.countryOfManufacture,/.test(direct));
check('the connector never reads customs items itself (adapters translate, they do not decide)',
  !/customsItems/.test(shippCode) && !/resolveCustomsOrigin/.test(shippCode));
check('the operator can now correct the origin, as they already could the description',
  /packageOriginCountry/.test(settings) && /packageDescription/.test(settings));
check('the configured default is read from credentials, the adapter concern',
  /creds\?\.packageOriginCountry/.test(shippCode));

if (failures > 0) {
  console.error(`\nFAIL PS-494 customs origin guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-494 customs origin guard');
