/**
 * PS-489 — executable contract fixtures. THESE ARE EXPECTED TO FAIL TODAY.
 *
 * This file is the definition of done for PS-489, written before the fix, at
 * Hermes's direction ("engineering may maintain the affected population query and
 * create failing contract fixtures, but should not implement an order-cost model
 * or silently reinterpret AC-2/AC-3").
 *
 * It is DELIBERATELY NOT enrolled in scripts/sot-guard-pack.mjs or CI. A red test
 * in the mandatory pack would either block every unrelated change or, worse, be
 * quietly weakened until it passed. It runs on demand via
 * `npm run test:ps-489-external-fulfillment-contract` and MUST be enrolled in the
 * pack as part of the PS-489 fix, in the same commit that turns it green.
 *
 * ── WHAT IS AND IS NOT DECIDED ──────────────────────────────────────────────────
 *
 * DJ has not yet ruled between the two models for the canonical fix:
 *   (A) shipment-row model — externally fulfilled orders receive a real canonical
 *       shipment/lifecycle record (the 2026-08-11 ruling, and the card's AC-2/AC-3).
 *       Hermes RECOMMENDS retaining this.
 *   (B) order-cost model — no shipment row; a fulfillment-scoped occurrence record
 *       feeds the canonical customer-money owner, with AC-2/AC-3 superseded.
 *
 * Sections 1-3 below are MODEL-INDEPENDENT: they hold under either ruling, so they
 * are safe to pin now. Section 4 states the model-dependent obligation WITHOUT
 * choosing, and asserts only that a named owner must exist — not which one.
 *
 * Nothing here writes to any database or calls any provider.
 */
import { readFileSync } from 'node:fs';
import { normalizeShipStationOrder } from '../src/connectors/store/shipstation';
import { retainOrderRawForPersistence } from '../src/services/order-raw-payload-policy';

let failures = 0;
let passes = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passes += 1;
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`  RED  ${name}`);
  if (detail !== undefined) console.error(`       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

console.log('\nPS-489 contract fixtures — RED lines are the work still to do\n');

// ── 1. nonMachinable is a parcel shape, not a fulfilment owner ──────────────────
//
// externallyShippedFromRaw ORs advancedOptions.nonMachinable into externally_shipped.
// nonMachinable is a USPS parcel-shape flag: it says the parcel is irregular, not
// that somebody else shipped it. Conflating them inflates the externally-shipped
// population, which is the population this whole ticket is scoped by.
//
// Measured 2026-08-21: 0 of the 149 international externally-shipped orders are
// driven by nonMachinable ALONE, so correcting this changes no current row — which
// is exactly why it should be corrected now, while it is free.
console.log('1. fulfilment ownership is not inferred from parcel shape');
{
  const nonMachinableOnly = normalizeShipStationOrder({
    orderId: 900001,
    orderNumber: 'PS489-NONMACH',
    orderStatus: 'shipped',
    advancedOptions: { nonMachinable: true },
  });
  check(
    'a nonMachinable parcel is NOT externally shipped',
    nonMachinableOnly.externallyShipped === false,
    `externallyShipped=${nonMachinableOnly.externallyShipped} — advancedOptions.nonMachinable is still ORed in at src/connectors/store/shipstation.ts:139-144`,
  );

  const genuinelyExternal = normalizeShipStationOrder({
    orderId: 900002,
    orderNumber: 'PS489-EXTERNAL',
    orderStatus: 'shipped',
    externallyFulfilled: true,
  });
  check(
    'a genuinely externally-fulfilled order still IS externally shipped',
    genuinelyExternal.externallyShipped === true,
    'the fix must narrow the predicate, not delete it',
  );
}

// ── 2. Cost evidence must survive ingestion ────────────────────────────────────
//
// The retention policy trims orders.raw to SHIPSTATION_RETAINED_KEYS. shipmentCost
// and shippingAmount are not in that list, so provider cost evidence is destroyed
// at ingestion. Measured 2026-08-21: 0 of 143 shipment-less international orders
// retain either field, so history cannot be recovered from raw — but every FUTURE
// order can, and that is what makes an evidence-first fix possible at all.
console.log('\n2. provider cost evidence survives payload retention');
{
  const retained = retainOrderRawForPersistence({
    sourceProvider: 'shipstation',
    raw: {
      orderId: 900003,
      orderNumber: 'PS489-COST',
      orderStatus: 'shipped',
      externallyFulfilled: true,
      shipmentCost: 7.42,
      shippingAmount: 9.99,
      shipTo: { country: 'CA' },
    },
  });
  check(
    'shipmentCost is retained',
    retained.shipmentCost === 7.42,
    `retained keys: ${Object.keys(retained).join(', ')}`,
  );
  check(
    'shippingAmount is retained',
    retained.shippingAmount === 9.99,
    'without it the tier-1 authority query in ps-489-external-fulfillment-preview.ts can never find cost on a new order',
  );
  check(
    'retention still drops unlisted keys (the policy is not simply widened)',
    !('someUnrelatedProviderField' in retainOrderRawForPersistence({
      sourceProvider: 'shipstation',
      raw: { someUnrelatedProviderField: 'x' },
    })),
  );
}

// ── 3. The invariant that must SURVIVE the fix ─────────────────────────────────
//
// DJ's standing rule: an unknown shipping cost is never silently billed as $0.
// billing.ts emits a terminal shipping_missing exception line instead. The fix
// must reduce how OFTEN that fires, never remove the branch. This section guards
// against a fix that makes the symptom disappear by deleting the alarm.
console.log('\n3. the unknown-cost exception stays terminal and visible');
{
  const billing = readFileSync('src/services/billing.ts', 'utf8').replace(/\r\n/g, '\n');
  check(
    'billing still emits a shipping_missing line for an externally-shipped order with no resolvable cost',
    /lineType: 'shipping_missing'/.test(billing)
      && /externallyShipped \|\| s\.externallyFulfilled \|\| s\.id === null/.test(billing),
    'the branch at src/services/billing.ts:~1567 must survive; the fix changes what reaches it, not that it exists',
  );
  check(
    'the exception line is $0.00 and never a guessed amount',
    /lineType: 'shipping_missing',[\s\S]{0,400}?unitCost: '0\.00'/.test(billing),
  );
}

// ── 4. The model-dependent obligation — stated, NOT chosen ─────────────────────
//
// Whichever model DJ rules for, the fix needs ONE named backend owner that decides
// what an externally fulfilled order's shipping charge is, and billing must consult
// it before falling through to the exception. Today that decision has no extractable
// owner at all: the logic is inline in generateLineItems, which is why there is
// nothing here to unit-test and why the drawer/billing divergence in CP-060 was
// possible in the first place.
//
// This assertion names the requirement without naming the mechanism. Update the
// expected module path in the SAME commit that implements DJ's ruling.
console.log('\n4. a named owner exists for the externally-fulfilled shipping charge');
{
  let ownerExists = false;
  try {
    readFileSync('src/services/external-fulfillment-shipping-charge.ts', 'utf8');
    ownerExists = true;
  } catch {
    ownerExists = false;
  }
  check(
    'a canonical owner module exists for the externally-fulfilled shipping charge',
    ownerExists,
    'expected src/services/external-fulfillment-shipping-charge.ts (name is provisional — rename in the implementing commit). '
      + 'Today the decision is inline in generateLineItems with no testable boundary. '
      + 'Under model A it resolves the charge for a minted external shipment row; under model B it resolves it for a '
      + 'fulfillment-scoped occurrence. Either way billing must CONSULT it rather than re-deciding.',
  );
}

console.log(`\n${passes} satisfied, ${failures} still RED`);
if (failures > 0) {
  console.log(
    '\nPS-489 is NOT implemented. Every RED line above is a contract term the fix must satisfy.\n'
    + 'Enroll this file in scripts/sot-guard-pack.mjs in the same commit that turns it green.',
  );
  process.exit(1);
}
console.log('\nPS-489 contract satisfied — enroll this file in the SOT guard pack now.');
