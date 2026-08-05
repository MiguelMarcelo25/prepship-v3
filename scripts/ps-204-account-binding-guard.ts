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
 * PS-317 A4 update: the FE direct-carrier label BUY (createDirectCarrierLabelThenQueue)
 * was DELETED — the frontend buys nothing and every queue order routes to the backend
 * create/recover job. The direct-buy account-binding that function carried is now
 * proven (a) ABSENT from the FE (anti-regression, no second money path) and (b) RELOCATED
 * to the intent payload (buildQueueSendOrderPayload) + the backend owner (createLabelV2's
 * directLabelAccountRefFromProviderId branch, gated by the same purchaseShippingProviderId
 * binding) + the print-queue route (processQueueSendOrder → createLabelV2).
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
import { buildSsLabelRequestBody, assertSsCarrierIdIsNotSynthetic } from '../src/lib/shipstation/label-request-body';
import {
  rateBelongsToProviderAccount,
  rateProviderAccountKey,
  rateQuoteRefFromCandidates,
} from '../web/src/lib/rate-proof';
import { classifyQueueOrderRouteServer } from '../src/services/print-queue/queue-route-orchestrator';

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
  // PS-422 retirement (2026-08-05): these two checks exercised the legacy SEMANTIC proof
  // selector, now deleted from web/src/lib/rate-proof.ts (zero application callers, and it
  // could not authorize postage regardless — createLabelV2 takes authority only from
  // selectionRef and overwrites selectedRateProof before provider dispatch). The rule they
  // proved is the ACCOUNT FILTER, which is SHARED code: filterCandidatesForAccount serves the
  // live opaque selector on the identical path. So the rule is repointed onto that selector
  // here, on the two behaviours the snapRef check below does NOT reach — identity-less
  // pass-through, and filtering happening BEFORE selection rather than after.
  check('account filter keeps identity-less candidates when bound (legacy rows pass, matching the backend binding skip)',
    rateQuoteRefFromCandidates([{ selectionRef: 'qsel_no_identity' }], { forShippingProviderId: 10000025 }).selectionRef === 'qsel_no_identity');
  check('account filter drops a cross-account ref BEFORE selection, so a later same-account ref wins',
    rateQuoteRefFromCandidates([
      { selectionRef: 'qsel_wrong_account', carrier_id: 'se-565377' },
      { selectionRef: 'qsel_right_account', carrier_id: 'se-10000025' },
    ], { forShippingProviderId: 10000025 }).selectionRef === 'qsel_right_account');
  const snapRef = { selectionRef: 'qsel_opaque', carrier_id: 'se-565377' };
  check('rateQuoteRefFromCandidates excludes cross-account opaque ref when bound',
    Object.keys(rateQuoteRefFromCandidates([snapRef], { forShippingProviderId: 10000025 })).length === 0 &&
    rateQuoteRefFromCandidates([snapRef]).selectionRef === 'qsel_opaque');
  check('rateProviderAccountKey mirrors backend normalization (se-/numeric forms)',
    rateProviderAccountKey({ carrier_id: 'se-10000025' }) === '10000025' &&
    rateProviderAccountKey({ shippingProviderId: '565377' }) === '565377');
}

// ── (6) Queue routing follows the LIVE panel payload, never-buy rungs intact ──
{
  const base = {
    hasQueueableLabel: false,
    isTest: false,
    isDirectCarrier: false,
    backendQueueRoute: 'backend' as const,
    explicitPayloadProviderId: null,
  };
  check('explicit direct payload (10000025) routes direct-create even when saved DTO says backend',
    classifyQueueOrderRouteServer({ ...base, explicitPayloadProviderId: 10000025 }) === 'direct-create');
  check('explicit ShipStation payload (565377) routes backend even when saved DTO says direct-create',
    classifyQueueOrderRouteServer({ ...base, backendQueueRoute: 'direct-create', explicitPayloadProviderId: 565377 }) === 'backend');
  check('never-buy rungs outrank the explicit payload (existing label / test modes)',
    classifyQueueOrderRouteServer({ ...base, hasQueueableLabel: true, explicitPayloadProviderId: 10000025 }) === 'backend' &&
    classifyQueueOrderRouteServer({ ...base, isTest: true, explicitPayloadProviderId: 10000025 }) === 'backend' &&
    classifyQueueOrderRouteServer({ ...base, explicitPayloadProviderId: 10000025 }, { batchTestMode: true }) === 'backend' &&
    classifyQueueOrderRouteServer({ ...base, explicitPayloadProviderId: 10000025 }, { existingLabelOnly: true }) === 'backend');
  check('no explicit payload → PS-176 backend policy preserved (batch flows unchanged)',
    classifyQueueOrderRouteServer({ ...base, backendQueueRoute: 'direct-create' }) === 'direct-create' &&
    classifyQueueOrderRouteServer({ ...base, backendQueueRoute: null, isDirectCarrier: true }) === 'direct-create' &&
    classifyQueueOrderRouteServer({ ...base, backendQueueRoute: null }) === 'backend');
}

// ── (7) Wiring pins: the binding is enforced at the real boundaries ───────────
const store = readFileSync('src/services/shipping-workflow/rate-quote-snapshot-store.ts', 'utf8');
check('assertLabelPurchaseRateSelection requires a stored typed account authorization',
  /authorization\?\.accounts\.find\(\(account\) => account\.shippingProviderId === providerId\)/.test(store) &&
  /if \(!authorization\?\.context \|\| !accountAuthorization\)/.test(store) &&
  /ShippingQuoteAuthorizationError\('order or carrier credential identity'\)/.test(store));
const labelsService = readFileSync('src/services/labels.ts', 'utf8');
check('createLabelV2 replaces the payload account with the authorized account',
  /shippingProviderId: authorizedPurchaseFacts\.shippingProviderId/.test(labelsService) &&
  /shippingQuoteAuthorizedPurchaseFacts\(purchaseSelection\)/.test(labelsService) &&
  /assertShippingQuoteAccountMatches\(\{/.test(labelsService));
const ssLabels = readFileSync('src/lib/shipstation/label-request-body.ts', 'utf8');
check('buildSsLabelRequestBody runs the synthetic-id assert before building',
  /assertSsCarrierIdIsNotSynthetic\(input\.carrierId\);/.test(ssLabels));
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('panel opaque selectionRef is account-bound (isTest skips)',
  /buildRateQuoteRefForOrder\(order, panelRatePreview\[0\] \?\? order\.bestRate \?\? order\.selectedRate, isTest \? null : shippingProviderId\)/.test(ordersView));
check('batch queue opaque selectionRef is account-bound',
  /buildRateQuoteRefForOrder\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(ordersView));
// PS-317 A4: the FE direct-carrier label BUY (createDirectCarrierLabelThenQueue,
// which resolved a purchase account from overrideRecord ?? resolveOrderShippingProviderId
// and fired apiClient.createLabel with a direct-carrier shipTo body) is DELETED. The
// frontend now buys NOTHING — every queue order routes to the backend create/recover
// job. The account-binding the deleted buy carried did NOT vanish; it relocated to
//   (a) the INTENT payload buildQueueSendOrderPayload (pid + account-bound proof + ref), and
//   (b) the BACKEND owner createLabelV2, which detects the direct carrier and runs the
//       SAME purchaseShippingProviderId account-binding ahead of either provider call.
// (1) Anti-regression: the FE direct-carrier buy must be GONE (no second money path).
check('FE direct-carrier buy is GONE — createDirectCarrierLabelThenQueue cannot exist (no FE postage)',
  !/createDirectCarrierLabelThenQueue/.test(ordersView) &&
  !/toNumberValue\(overrideRecord\?\.shippingProviderId\)[\s\S]{0,160}\?\?\s*resolveOrderShippingProviderId\(order\)/.test(ordersView));
// (2) Relocated to the INTENT payload: the queue-send payload still names the purchase
//     account and account-binds BOTH the fallback proof and the rate-quote ref to it.
check('queue-send INTENT payload names the purchase account + account-filters the opaque selectionRef',
  /function buildQueueSendOrderPayload\([\s\S]*?shippingProviderId: shippingProviderId \?\? undefined,[\s\S]*?buildRateQuoteRefForOrder\(order, bestRate \?\? selectedRate, shippingProviderId\)/.test(ordersView) &&
  !/function buildQueueSendOrderPayload\([\s\S]*?selectedRateProof: buildSelectedRateProofPayload/.test(ordersView));
// (3) Relocated to the BACKEND owner: createLabelV2 detects the direct carrier and binds
//     the purchase account on the SAME boundary that already gated ShipStation (the
//     purchaseShippingProviderId pin at line ~174 proves the binding runs ahead of BOTH).
check('backend createLabelV2 owns the direct-carrier branch via directLabelAccountRefFromProviderId(body.shippingProviderId)',
  /directLabelAccountRefFromProviderId\(body\.shippingProviderId\)/.test(labelsService));
// (4) The queue route the FE now hands off to: print-queue processQueueSendOrder buys via
//     createLabelV2 (so the relocated binding above governs the queue path the deleted FE buy used to own).
const printQueueService = readFileSync('src/services/print-queue.ts', 'utf8');
check('print-queue processQueueSendOrder routes the queue order through the backend createLabelV2 owner',
  /async function processQueueSendOrder\(/.test(printQueueService) &&
  /createLabelV2\(input, labelPurchaseScope\)/.test(printQueueService));
check('Ship Acct change drops a preview rate from another account (no mixed-source card)',
  /setPanelRatePreview\(\(current\) => \{\s*\n\s*const belongs = rateBelongsToProviderAccount\(current\[0\], nextValue\)/.test(ordersView));
check('mixed-source purchase shows the re-rate action instead of a generic failure',
  /different carrier account/.test(ordersView) && /Browse Rates for/.test(ordersView));
check('OrdersView no longer owns queue route classification after PS-359',
  !/from '\.\.\/\.\.\/lib\/shipping-routes'/.test(ordersView) &&
  !/from '\.\.\/\.\.\/lib\/resolve-backend-route-plan'/.test(ordersView) &&
  /const backendJobOrders = jobOrders/.test(ordersView));

if (failures > 0) {
  console.error(`\nFAIL PS-204 account-binding guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-204 account-binding guard');
