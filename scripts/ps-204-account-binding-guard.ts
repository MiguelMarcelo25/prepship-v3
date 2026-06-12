/**
 * PS-204 guard — one canonical rate source: the selected-rate proof is BOUND to
 * the purchase account, synthetic direct ids can never be EMITTED to
 * ShipStation, queue routing follows the live panel payload, and the FE can no
 * longer compose a mixed-source rate card (amount/proof from account A labeled
 * as account B).
 *
 * Production fixture (HUGRAB order 1484): the panel had selected provider id
 * 10000025 (carrier_accounts row 25 + 10M synthetic offset, Shipp) while the
 * working proof belonged to ShipStation se-565377 — the purchase payload, the
 * displayed account, and the rate proof disagreed and nothing compared them.
 *
 * Offline + pure: behavioral checks call the pure owners directly; source pins
 * verify the wiring. No network, no DB, no postage.
 *
 *   npx tsx scripts/ps-204-account-binding-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  SelectedRateProofError,
  assertPurchaseAccountMatchesProof,
  validatePurchaseAccountBinding,
  selectedRateProviderAccountKey,
} from '../src/services/shipping-workflow/rate-fingerprint';
import { resolveRateQuoteForPurchase, selectedRateOpaqueKey } from '../src/services/shipping-workflow/rate-quote-snapshot';
import { buildSsLabelRequestBody, assertSsCarrierIdIsNotSynthetic } from '../src/lib/shipstation/labels';
import {
  rateBelongsToProviderAccount,
  rateProviderAccountKey,
  selectProofFromCandidates,
  rateQuoteRefFromCandidates,
} from '../web/src/lib/rate-proof';
import { classifyQueueOrderRoute } from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── (1) Pure binding: the 1484 fixture blocks; same-account passes ───────────
{
  const r = validatePurchaseAccountBinding({
    purchaseShippingProviderId: 10000025,
    selectedRate: { carrier_id: 'se-565377', serviceCode: 'ups_ground' },
  });
  check('1484 fixture: payload pid 10000025 vs proof se-565377 → purchase_account_mismatch',
    !r.ok && r.reason === 'purchase_account_mismatch');
}
check('same account (565377 vs se-565377) passes',
  validatePurchaseAccountBinding({ purchaseShippingProviderId: 565377, selectedRate: { carrier_id: 'se-565377' } }).ok);
check('no purchase pid → binding skipped (never weaker than pre-PS-204)',
  validatePurchaseAccountBinding({ purchaseShippingProviderId: null, selectedRate: { carrier_id: 'se-565377' } }).ok);
check('identity-less proof rate → binding skipped (legacy rows unchanged)',
  validatePurchaseAccountBinding({ purchaseShippingProviderId: 565377, selectedRate: { serviceCode: 'ups_ground', cost: 7.66 } }).ok);
check('proof identity readable from raw + shippingProviderId forms',
  selectedRateProviderAccountKey({ raw: { carrier_id: 'se-10000025' } }) === '10000025' &&
  selectedRateProviderAccountKey({ shippingProviderId: 10000025 }) === '10000025');

// ── (2) Throwing wrapper: SelectedRateProofError with actionable codes ────────
{
  let thrown: unknown = null;
  try {
    assertPurchaseAccountMatchesProof({ purchaseShippingProviderId: 10000025, selectedRate: { carrier_id: 'se-565377' } });
  } catch (err) { thrown = err; }
  check('synthetic payload on a ShipStation proof throws DIRECT_CARRIER_ON_SHIPSTATION_PATH',
    thrown instanceof SelectedRateProofError && (thrown as SelectedRateProofError).code === 'DIRECT_CARRIER_ON_SHIPSTATION_PATH');
  check('mismatch error message is actionable + confirms no postage',
    thrown instanceof Error && /Re-rate|re-rate/.test(thrown.message) && /No postage was purchased/.test(thrown.message));
}
{
  let thrown: unknown = null;
  try {
    assertPurchaseAccountMatchesProof({ purchaseShippingProviderId: 123456, selectedRate: { carrier_id: 'se-565377' } });
  } catch (err) { thrown = err; }
  check('cross-account (both ShipStation) throws SELECTED_RATE_ACCOUNT_MISMATCH',
    thrown instanceof SelectedRateProofError && (thrown as SelectedRateProofError).code === 'SELECTED_RATE_ACCOUNT_MISMATCH');
}

// ── (3) Snapshot proof path enforces the same binding ─────────────────────────
{
  const fp = 'v=3|d=2026-06-12|w=320|z=94601|co=US';
  const snapRate = {
    carrier_id: 'se-565377', serviceCode: 'ups_ground', shipmentCost: 7.66,
    proofSource: 'backend_rate_response',
  };
  const resolved = resolveRateQuoteForPurchase({
    snapshot: { cacheKey: fp, rates: [snapRate], fetchedAt: new Date().toISOString() },
    selectedRateKey: selectedRateOpaqueKey(snapRate),
    now: Date.now(),
  });
  check('snapshot fixture resolves a proof', resolved.ok === true);
  let thrown: unknown = null;
  if (resolved.ok) {
    try {
      assertPurchaseAccountMatchesProof({ purchaseShippingProviderId: 10000025, selectedRate: resolved.proof.selectedRate });
    } catch (err) { thrown = err; }
  }
  check('snapshot-resolved rate + mismatched purchase account blocks before any provider call',
    thrown instanceof SelectedRateProofError);
}

// ── (4) Last-mile: se-1xxxxxxx can NEVER be emitted to ShipStation ────────────
{
  let thrown: unknown = null;
  try { assertSsCarrierIdIsNotSynthetic('se-10000025'); } catch (err) { thrown = err; }
  check('assertSsCarrierIdIsNotSynthetic rejects se-10000025 with DIRECT_CARRIER_ON_SHIPSTATION_PATH',
    thrown instanceof Error && (thrown as Error & { code?: string }).code === 'DIRECT_CARRIER_ON_SHIPSTATION_PATH');
}
{
  let thrown: unknown = null;
  const input = {
    carrierId: 'se-10000025', serviceCode: 'ups_ground', packageCode: 'package', weightOz: 32,
    length: 12, width: 10, height: 6,
    shipTo: { name: 'T', street1: '1 Main', city: 'Oakland', state: 'CA', postalCode: '94601', country: 'US' },
    shipFrom: { name: 'F', street1: '2 Main', city: 'Gardena', state: 'CA', postalCode: '90248', country: 'US' },
    ssOrderId: null, orderNumber: '1484',
  };
  try { buildSsLabelRequestBody(input as Parameters<typeof buildSsLabelRequestBody>[0]); } catch (err) { thrown = err; }
  check('buildSsLabelRequestBody cannot emit carrier_id se-10000025', thrown instanceof Error);
  let ok = false;
  try {
    const body = buildSsLabelRequestBody({ ...input, carrierId: 'se-565377' } as Parameters<typeof buildSsLabelRequestBody>[0]);
    ok = (body as { shipment: { carrier_id: string } }).shipment.carrier_id === 'se-565377';
  } catch { ok = false; }
  check('real ShipStation carrier_id se-565377 still builds', ok);
}

// ── (5) FE proof candidates are account-filtered; legacy semantics intact ─────
{
  const ssProofRate = { carrier_id: 'se-565377', requestFingerprint: 'fp_1', proofSource: 'backend_rate_response' };
  check('rateBelongsToProviderAccount: se-565377 rate vs pid 10000025 → false; vs 565377 → true; identity-less → null',
    rateBelongsToProviderAccount(ssProofRate, 10000025) === false &&
    rateBelongsToProviderAccount(ssProofRate, 565377) === true &&
    rateBelongsToProviderAccount({ cost: 7.66 }, 565377) === null);
  check('selectProofFromCandidates excludes cross-account proof when bound to an account',
    selectProofFromCandidates([ssProofRate], { forShippingProviderId: 10000025 }) === undefined);
  check('selectProofFromCandidates unchanged without binding (legacy callers)',
    selectProofFromCandidates([ssProofRate])?.selectedRate === ssProofRate);
  const snapRef = { rateQuoteId: 'rq_1', selectedRateKey: 'srk_1', carrier_id: 'se-565377' };
  check('rateQuoteRefFromCandidates excludes cross-account snapshot ref when bound',
    Object.keys(rateQuoteRefFromCandidates([snapRef], { forShippingProviderId: 10000025 })).length === 0 &&
    rateQuoteRefFromCandidates([snapRef]).rateQuoteId === 'rq_1');
  check('rateProviderAccountKey mirrors backend normalization (se-/numeric forms)',
    rateProviderAccountKey({ carrier_id: 'se-10000025' }) === '10000025' &&
    rateProviderAccountKey({ shippingProviderId: '565377' }) === '565377');
}

// ── (6) Queue routing follows the LIVE panel payload, never-buy rungs intact ──
{
  const base = { hasQueueableLabel: false, isTest: false, isDirectCarrier: false, backendQueueRoute: 'backend' as const };
  check('explicit direct payload (10000025) routes direct-create even when saved DTO says backend',
    classifyQueueOrderRoute({ ...base, explicitPayloadProviderId: 10000025 }) === 'direct-create');
  check('explicit ShipStation payload (565377) routes backend even when saved DTO says direct-create',
    classifyQueueOrderRoute({ ...base, backendQueueRoute: 'direct-create', explicitPayloadProviderId: 565377 }) === 'backend');
  check('never-buy rungs outrank the explicit payload (existing label / test modes)',
    classifyQueueOrderRoute({ ...base, hasQueueableLabel: true, explicitPayloadProviderId: 10000025 }) === 'backend' &&
    classifyQueueOrderRoute({ ...base, isTest: true, explicitPayloadProviderId: 10000025 }) === 'backend' &&
    classifyQueueOrderRoute({ ...base, explicitPayloadProviderId: 10000025 }, { batchTestMode: true }) === 'backend' &&
    classifyQueueOrderRoute({ ...base, explicitPayloadProviderId: 10000025 }, { existingLabelOnly: true }) === 'backend');
  check('no explicit payload → PS-176 backend policy preserved (batch flows unchanged)',
    classifyQueueOrderRoute({ ...base, backendQueueRoute: 'direct-create' }) === 'direct-create' &&
    classifyQueueOrderRoute({ ...base, backendQueueRoute: null, isDirectCarrier: true }) === 'direct-create' &&
    classifyQueueOrderRoute({ ...base, backendQueueRoute: null }) === 'backend');
}

// ── (7) Wiring pins: the binding is enforced at the real boundaries ───────────
const store = readFileSync('src/services/shipping-workflow/rate-quote-snapshot-store.ts', 'utf8');
check('assertLabelPurchaseRateSelection binds the account on BOTH proof paths (snapshot + legacy)',
  (store.match(/assertPurchaseAccountMatchesProof\(\{/g) ?? []).length >= 2 &&
  /purchaseShippingProviderId\?: unknown/.test(store));
const labelsService = readFileSync('src/services/labels.ts', 'utf8');
check('createLabelV2 passes the payload account into the purchase boundary',
  /purchaseShippingProviderId: body\.shippingProviderId/.test(labelsService));
const ssLabels = readFileSync('src/lib/shipstation/labels.ts', 'utf8');
check('buildSsLabelRequestBody runs the synthetic-id assert before building',
  /assertSsCarrierIdIsNotSynthetic\(input\.carrierId\);/.test(ssLabels));
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('panel payload proof + quote-ref are account-bound (isTest skips)',
  /buildSelectedRateProofPayload\(order, panelRatePreview\[0\] \?\? order\.bestRate \?\? order\.selectedRate, isTest \? null : shippingProviderId\)/.test(ordersView) &&
  /buildRateQuoteRefForOrder\(order, panelRatePreview\[0\] \?\? order\.bestRate \?\? order\.selectedRate, isTest \? null : shippingProviderId\)/.test(ordersView));
check('batch queue payload proof is account-bound',
  /buildSelectedRateProofPayload\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(ordersView));
check('Ship Acct change drops a preview rate from another account (no mixed-source card)',
  /setPanelRatePreview\(\(current\) => \{\s*\n\s*const belongs = rateBelongsToProviderAccount\(current\[0\], nextValue\)/.test(ordersView));
check('mixed-source purchase shows the re-rate action instead of a generic failure',
  /belongs to a different carrier account — Browse Rates for/.test(ordersView));
check('queue routing consumes the live override payload pid',
  /explicitPayloadProviderId: overrideProviderId/.test(ordersView));

if (failures > 0) {
  console.error(`\nFAIL PS-204 account-binding guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-204 account-binding guard');
