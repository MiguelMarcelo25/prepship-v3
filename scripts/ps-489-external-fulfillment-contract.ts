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
 *
 * ── OFFLINE BY CONSTRUCTION (Hermes correction C1) ──────────────────────────────
 *
 * The advertised command must be self-contained. Before this preamble existed, a
 * clean checkout (no local `.env`) died BEFORE a single fixture ran:
 *
 *     Invalid environment variables:
 *     { DATABASE_URL: [ 'Required' ], SUPABASE_URL: [ 'Required' ],
 *       SUPABASE_ANON_KEY: [ 'Required' ], SUPABASE_SERVICE_ROLE_KEY: [ 'Required' ],
 *       SUPABASE_JWT_SECRET: [ 'Required' ] }
 *
 * because src/lib/env.ts validates at module load and is pulled in transitively by
 * the connector tree. That still exited 1, which is the same exit code a genuinely
 * RED contract produces — so a dead harness was indistinguishable from a working
 * one. The dummy values below are obviously non-production and are set with `??=`,
 * so a real environment (or CI) still wins; they exist only to let module-load
 * validation pass. src modules are then imported DYNAMICALLY, because static
 * imports are hoisted and would run before these assignments.
 *
 * This copies the established convention for offline scripts in this repo — see
 * scripts/audit-sync-watchdog-lifecycle-guard.ts:10-20.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://ci:ci@localhost:5432/ci';
process.env.SUPABASE_URL ??= 'https://ci.example.invalid';
process.env.SUPABASE_ANON_KEY ??= 'ci-anon';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'ci-service-role';
process.env.SUPABASE_JWT_SECRET ??= 'ci-jwt-secret';

const { normalizeShipStationOrder } = await import('../src/connectors/store/shipstation');
const { retainOrderRawForPersistence } = await import('../src/services/order-raw-payload-policy');

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
//
// ── THE TWO FIELDS ARE NOT THE SAME KIND OF EVIDENCE (Hermes correction C2) ─────
//
// Retaining BOTH is required, but for DIFFERENT reasons, and the distinction is
// load-bearing — collapsing it is how the order-cost model gets smuggled in
// through a retention change:
//
//   shipmentCost    — CANDIDATE provider/carrier-cost evidence. It is the only
//                     field the existing tier-1 authority query consults:
//                     scripts/ps-489-external-fulfillment-preview.ts:137-138 reads
//                     `o.raw->>'shipmentCost'` and nothing else (`shippingAmount`
//                     does not appear anywhere in that file). "Candidate" is not a
//                     hedge: whether ShipStation's shipmentCost means the carrier's
//                     charge on THIS parcel, under external fulfilment, is a
//                     provider-semantics question that must be verified before it
//                     is billed as carrier cost.
//
//   shippingAmount  — the CUSTOMER/ORDER shipping amount: what the buyer was
//                     charged on the order. It is NOT automatically carrier cost,
//                     and nothing may treat it as the tier-1 cost authority. It is
//                     retained as BOUNDED CONTEXTUAL EVIDENCE only — useful to a
//                     human reconciling a disputed line, or to bound a candidate
//                     cost for plausibility, never to source one.
//
// Billing customer-paid shipping as though it were carrier cost is precisely the
// order-cost model (B) that DJ has not ruled for. This fixture must not imply it.
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
    'shipmentCost is retained — candidate provider/carrier-cost evidence',
    retained.shipmentCost === 7.42,
    'this is the ONLY field the tier-1 cost authority reads '
      + '(scripts/ps-489-external-fulfillment-preview.ts:137-138). Dropping it at ingestion means no future '
      + 'externally-fulfilled order can ever present carrier-cost evidence. Retaining it does NOT by itself make it '
      + `billable — provider semantics must be verified first. Retained keys: ${Object.keys(retained).join(', ')}`,
  );
  check(
    'shippingAmount is retained — customer/order shipping amount, contextual evidence only',
    retained.shippingAmount === 9.99,
    'this is what the CUSTOMER was charged on the order. It is NOT carrier cost and is NOT consulted by the tier-1 '
      + 'authority query (`shippingAmount` appears nowhere in ps-489-external-fulfillment-preview.ts). It is retained '
      + 'as bounded contextual evidence so a human can reconcile or sanity-bound a disputed line. Any fix that sources '
      + 'a billable carrier cost FROM this field has adopted the order-cost model (B), which DJ has not ruled for.',
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
//
// ── KNOWN WEAKNESS, DO NOT LEAVE AS-IS (Hermes correction C3) ──────────────────
//
// Both checks in this section are STATIC REGEX checks against billing.ts source
// text, not executions of billing. They therefore prove only that the source still
// LOOKS right: a refactor that preserves the matched tokens while changing what
// actually reaches the branch would keep them green — the token-preserving failure
// mode. They are recorded here as green invariants because the branch genuinely
// exists today, not because regex is adequate proof.
//
// These two MUST be converted into an executable billing fixture — one that runs
// generateLineItems (or its extracted owner) over an externally-shipped order with
// no resolvable cost and asserts the emitted line is shipping_missing at 0.00 — in
// the IMPLEMENTATION commit. Deliberately NOT converted now: writing an executable
// billing fixture requires deciding which owner billing consults, and that is the
// model-dependent question section 4 refuses to pre-answer on DJ's behalf.
console.log('\n3. the unknown-cost exception stays terminal and visible');
{
  const billing = readFileSync('src/services/billing.ts', 'utf8').replace(/\r\n/g, '\n');
  check(
    'billing still emits a shipping_missing line for an externally-shipped order with no resolvable cost [STATIC REGEX — convert to executable fixture in the implementation commit]',
    /lineType: 'shipping_missing'/.test(billing)
      && /externallyShipped \|\| s\.externallyFulfilled \|\| s\.id === null/.test(billing),
    'the branch at src/services/billing.ts:~1567 must survive; the fix changes what reaches it, not that it exists',
  );
  check(
    'the exception line is $0.00 and never a guessed amount [STATIC REGEX — convert to executable fixture in the implementation commit]',
    /lineType: 'shipping_missing',[\s\S]{0,400}?unitCost: '0\.00'/.test(billing),
  );
}

// ── 4. The model-dependent obligation — stated, NOT chosen ─────────────────────
//
// Whichever model DJ rules for, the fix needs ONE canonical backend owner that
// decides what an externally fulfilled order's shipping charge is, and billing must
// CONSULT it before falling through to the exception. Today that decision has no
// extractable owner at all: the logic is inline in generateLineItems, which is why
// there is nothing here to unit-test and why the drawer/billing divergence in
// CP-060 was possible in the first place.
//
// ── THIS PINS A ROLE, NOT A FILENAME (Hermes correction C3) ────────────────────
//
// An earlier version readFileSync'd one provisional path
// (src/services/external-fulfillment-shipping-charge.ts). That made a valid owner
// shipped under any other name fail the contract — the fixture would have demanded
// a filename it had invented rather than the behaviour the ticket needs.
//
// This is now an import-and-behaviour contract, discovered through billing's OWN
// import graph:
//   1. read billing.ts and collect the modules it actually imports;
//   2. find one whose source EXPORTS a resolver for this role (name contains
//      external/externally + shipping/shipment + charge/cost/amount);
//   3. import that module and confirm the export is really callable.
// Discovering the owner via billing's imports proves ownership AND caller
// delegation in a single step, with no path pinned: any filename satisfies this so
// long as billing consults it. Every step is wrapped so a missing owner reports RED
// rather than throwing — a fixture that crashes proves nothing.
console.log('\n4. a canonical owner exists for the externally-fulfilled shipping charge, and billing consults it');
{
  const ROLE = /^(?=.*extern)(?=.*(shipping|shipment))(?=.*(charge|cost|amount)).+$/i;
  const EXPORTED = /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g;

  let ownerModule: string | null = null;
  let ownerExport: string | null = null;
  let delegationProven = false;
  let diagnostic = '';

  try {
    const billingPath = 'src/services/billing.ts';
    const billingSrc = readFileSync(billingPath, 'utf8').replace(/\r\n/g, '\n');

    // Modules billing actually imports (relative specifiers only — the owner must live in this repo).
    const specifiers = [...billingSrc.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
    const seen = new Set<string>();

    for (const spec of specifiers) {
      if (seen.has(spec)) continue;
      seen.add(spec);
      const base = resolve(dirname(billingPath), spec).replace(/\.js$/, '');
      let src: string | null = null;
      for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        try { src = readFileSync(candidate, 'utf8'); break; } catch { /* try next extension */ }
      }
      if (src === null) continue;

      for (const [, name] of src.replace(/\r\n/g, '\n').matchAll(EXPORTED)) {
        if (!ROLE.test(name)) continue;
        ownerModule = spec;
        ownerExport = name;
        break;
      }
      if (ownerModule !== null) break;
    }

    if (ownerModule !== null && ownerExport !== null) {
      // Confirm the discovered export is genuinely callable, not just a matching token in source.
      // pathToFileURL is REQUIRED, not cosmetic: on Windows `import('X:/...')` throws
      // ERR_UNSUPPORTED_ESM_URL_SCHEME. That throw is caught below and reported as RED — so
      // without this the check could never go green on a Windows dev machine no matter how
      // correct the implementation was. Verified by replaying this discovery against a fixture
      // owner under a different filename: it goes green only with the file:// URL form.
      const mod = (await import(
        pathToFileURL(resolve(dirname(billingPath), ownerModule).replace(/\.js$/, '')).href
      )) as Record<string, unknown>;
      delegationProven = typeof mod[ownerExport] === 'function';
      if (!delegationProven) diagnostic = `${ownerModule} exports ${ownerExport}, but it is not callable`;
    }
  } catch (error) {
    // Fail gracefully: a RED line with a diagnostic, never an unhandled throw.
    diagnostic = `owner discovery could not complete: ${error instanceof Error ? error.message : String(error)}`;
  }

  check(
    'billing imports a canonical owner that resolves the externally-fulfilled shipping charge',
    delegationProven,
    'No module imported by src/services/billing.ts exports a callable resolver for this role. '
      + 'REQUIREMENT (ownership + caller delegation, not a filename): exactly one canonical backend owner must decide '
      + "what an externally fulfilled order's shipping charge is, and billing must CONSULT that owner instead of "
      + 're-deciding inline in generateLineItems. Any module name satisfies this contract — it is discovered through '
      + "billing's own import graph — provided the exported resolver names the role (external + shipping/shipment + "
      + 'charge/cost/amount) and billing imports it. Under model A the owner resolves the charge for a minted external '
      + 'shipment row; under model B, for a fulfillment-scoped occurrence. The contract is deliberately silent on which.'
      + (diagnostic ? ` [${diagnostic}]` : ''),
  );
}

console.log(`\n${passes} satisfied, ${failures} still RED`);
if (failures > 0) {
  console.log(
    '\nPS-489 is NOT implemented. Every RED line above is a contract term the fix must satisfy.\n'
    + 'Enroll this file in scripts/sot-guard-pack.mjs in the same commit that turns it green.\n'
    + 'Also convert the two [STATIC REGEX] shipping_missing checks in section 3 into an executable billing fixture.',
  );
  process.exit(1);
}
console.log('\nPS-489 contract satisfied — enroll this file in the SOT guard pack now.');
