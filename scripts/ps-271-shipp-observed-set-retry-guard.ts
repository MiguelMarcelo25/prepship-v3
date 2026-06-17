/**
 * PS-271 (Layer 1) — Shipp observed-set thin-response retry guard (BEHAVIORAL).
 *
 * Drives the REAL Shipp connector (createShippCarrierConnector().getRates) through the project's own
 * offline carrier-replay harness (__setCarrierReplay, gated by CARRIER_TEST_MODE) — NO live Shipp, NO
 * network, NO postage. Proves the #1502 fix end-to-end:
 *
 *   1. A non-empty 200 that is THIN (FedEx-only while {ups,fedex} is observed-expected) triggers ONE
 *      re-ask; the 2nd pass returns UPS+FedEx -> the complete set is returned (re-quoted before cap).
 *   2. STILL thin at the cap (FedEx-only both passes) -> ACCEPT the partial (FedEx), never throw.
 *   3. An EMPTY 200 still HARD-THROWS ("Shipp returned 0 rates...") — accept-partial is ONLY for
 *      non-empty-but-thin.
 *   4. DEFAULT OFF: with the opt-in flag absent, exactly ONE /quote POST happens (no observed-set
 *      logic, no re-ask) — i.e. today's behavior.
 *   5. The pure decision (missingObservedCarriers) never expects USPS and never re-asks without prior
 *      evidence.
 *
 *   npx tsx scripts/ps-271-shipp-observed-set-retry-guard.ts
 */
process.env.CARRIER_TEST_MODE = '1';
// Keep the durable cache/cooldown OFF so the connector touches NO database in this offline guard.
delete process.env.DIRECT_CARRIER_RATE_CACHE;

import { __setCarrierReplay, type CarrierReplayStep } from '../src/lib/http/timing';
import { createShippCarrierConnector } from '../src/connectors/carrier/shipp';
import { missingObservedCarriers } from '../src/connectors/carrier/shipp-observed-carriers';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const CREDS = { apiKey: 'k', email: 'e@x.com', password: 'p', shipFromCity: 'Carson', shipFromState: 'CA' };
const LOGIN_STEP: CarrierReplayStep = {
  name: 'shipp.login',
  status: 200,
  body: { session: { access_token: 'a', refresh_token: 'r' } },
};
const ZIP_STEP: CarrierReplayStep = {
  name: 'shipp.zip-lookup',
  status: 200,
  body: { places: [{ 'place name': 'Oakland', 'state abbreviation': 'CA' }] },
};
const upsRate = { carrierType: 'UPS', serviceName: 'Ground', price: 10.14, quoted_shipment_id: 'q-ups', serviceType: 'GND' };
const fedexRate = { carrierType: 'FedEx', serviceName: 'Home Delivery', price: 11.66, quoted_shipment_id: 'q-fx', serviceType: 'HD' };

function baseInput(extra: Record<string, unknown> = {}) {
  return {
    credentials: { ...CREDS },
    weightOz: 31,
    toZip: '94601',
    dimsL: 6, dimsW: 6, dimsH: 6,
    rawOrder: { shipTo: { name: 'Buyer', street1: '1 Main St', city: 'Oakland', state: 'CA', postalCode: '94601', country: 'US' } },
    ...extra,
  } as Record<string, unknown>;
}

async function run() {
  const connector = createShippCarrierConnector();

  // ── 1) THIN first pass -> re-ask -> complete UPS+FedEx ─────────────────────
  __setCarrierReplay([
    LOGIN_STEP,
    ZIP_STEP,
    { name: 'shipp.rates', status: 200, body: { rates: [fedexRate] } },        // thin: FedEx only
    { name: 'shipp.rates.retry', status: 200, body: { rates: [upsRate, fedexRate] } }, // re-ask: complete
  ]);
  const completed = await connector.getRates(baseInput({
    credentials: { ...CREDS, shippObservedSetRetry: true },
    shippObservedCarriers: ['ups', 'fedex'],
  }));
  const completedCarriers = new Set(completed.map((r: any) => r.carrierCode));
  check('thin first pass re-asks and the complete UPS+FedEx set is returned',
    completedCarriers.has('ups') && completedCarriers.has('fedex'));
  check('the re-quoted set includes the cheaper UPS $10.14 (the #1502 win)',
    completed.some((r: any) => r.carrierCode === 'ups' && Number(r.cost) === 10.14));

  // ── 2) STILL thin at the cap -> accept the partial FedEx (no throw) ────────
  __setCarrierReplay([
    LOGIN_STEP,
    ZIP_STEP,
    { name: 'shipp.rates', status: 200, body: { rates: [fedexRate] } },        // thin
    { name: 'shipp.rates.retry', status: 200, body: { rates: [fedexRate] } },  // still thin at cap
  ]);
  let acceptedPartial: any[] = [];
  let threwOnPartial = false;
  try {
    acceptedPartial = await connector.getRates(baseInput({
      credentials: { ...CREDS, shippObservedSetRetry: true },
      shippObservedCarriers: ['ups', 'fedex'],
    }));
  } catch { threwOnPartial = true; }
  check('still-thin at the cap ACCEPTS the partial (never throws on non-empty-but-thin)', !threwOnPartial);
  check('the accepted partial is the FedEx rate that DID come back',
    acceptedPartial.length === 1 && acceptedPartial[0]?.carrierCode === 'fedex');

  // ── 3) EMPTY 200 still HARD-THROWS ─────────────────────────────────────────
  __setCarrierReplay([
    LOGIN_STEP,
    ZIP_STEP,
    { name: 'shipp.rates', status: 200, body: { rates: [] } },
  ]);
  let emptyMsg = '';
  try {
    await connector.getRates(baseInput({
      credentials: { ...CREDS, shippObservedSetRetry: true },
      shippObservedCarriers: ['ups', 'fedex'],
    }));
  } catch (err) { emptyMsg = err instanceof Error ? err.message : String(err); }
  check('an empty 200 still hard-throws "Shipp returned 0 rates"', /Shipp returned 0 rates/.test(emptyMsg));

  // ── 4) DEFAULT OFF: flag absent -> ONE POST, no re-ask ─────────────────────
  // Queue ONLY a single shipp.rates step. If the connector tried a 2nd POST it would fall through to
  // real network (no shipp.rates.retry step) and throw — so a clean FedEx-only return proves exactly
  // one POST and no observed-set logic ran.
  __setCarrierReplay([
    LOGIN_STEP,
    ZIP_STEP,
    { name: 'shipp.rates', status: 200, body: { rates: [fedexRate] } },
  ]);
  let offResult: any[] = [];
  let offThrew = false;
  try {
    // No shippObservedSetRetry in credentials, no injected observed set -> feature OFF.
    offResult = await connector.getRates(baseInput());
  } catch { offThrew = true; }
  check('flag OFF: a single POST is made and the FedEx-only result is returned unchanged',
    !offThrew && offResult.length === 1 && offResult[0]?.carrierCode === 'fedex');

  __setCarrierReplay(null);

  // ── 5) pure decision: never expects USPS, never re-asks without evidence ────
  check('missingObservedCarriers reports UPS missing when only FedEx returned',
    JSON.stringify(missingObservedCarriers(['ups', 'fedex'], ['fedex'])) === JSON.stringify(['ups']));
  check('missingObservedCarriers reports nothing missing when the full set returned',
    missingObservedCarriers(['ups', 'fedex'], ['fedex', 'ups']).length === 0);
  check('missingObservedCarriers never invents USPS (cannot be in an observed set)',
    missingObservedCarriers([], ['fedex']).length === 0);
}

run().then(() => {
  if (failures > 0) {
    console.error(`\nFAIL PS-271 Shipp observed-set retry guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-271 Shipp observed-set retry guard');
}).catch((err) => {
  console.error('FAIL PS-271 Shipp observed-set retry guard threw:', err);
  process.exit(1);
});
