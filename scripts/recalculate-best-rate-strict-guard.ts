/**
 * Guard: side-panel Recalculate must perform a strict live best-rate update.
 *
 * It must not open Browse Rates, use cached/stale order fallback rates, or
 * silently keep an old best rate after a clean no-rate result.
 *
 * PS-178 final part: the FE copy of the decision (planStrictBestRateRecalculate)
 * was DELETED — the decision is backend-owned (response.strictRecalculation).
 * The behavioral matrix below now runs against the canonical backend owner,
 * src/services/rates-recalculate.ts, with the same fixtures.
 *
 * Read-only: no DB, no network, no provider calls.
 */
import { readFileSync } from 'node:fs';
import { planStrictRecalculateDecision } from '../src/services/rates-recalculate';

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

{
  const decision = planStrictRecalculateDecision({
    liveBestAmount: 7.45,
    providerAccountId: 433542,
    serviceCode: 'usps_ground_advantage',
    carrierStatuses: [
      { carrierId: 'se-433542', status: 'live', rateCount: 4 },
      { carrierId: 'se-10000007', status: 'unavailable', rateCount: 0 },
    ],
  });
  check('clean live response with usable best rate applies', decision.action === 'apply');
  check('apply decision selects provider account', decision.action === 'apply' && decision.selectedPid === 433542);
  check('apply decision selects service', decision.action === 'apply' && decision.serviceCode === 'usps_ground_advantage');
}

{
  const decision = planStrictRecalculateDecision({
    liveBestAmount: 7.45,
    providerAccountId: 433542,
    serviceCode: 'usps_ground_advantage',
    carrierStatuses: [
      { carrierId: 'se-433542', status: 'live', rateCount: 4 },
      { carrierId: 'se-10000007', status: 'error', rateCount: 0, error: 'carrier timed out' },
    ],
  });
  check('any carrier error blocks update', decision.action === 'blocked');
  check('blocked decision carries an operator-actionable message', decision.action === 'blocked' && Boolean(decision.message));
}

check('cached carrier status blocks strict live recalculation',
  planStrictRecalculateDecision({
    liveBestAmount: 7.45,
    providerAccountId: 433542,
    serviceCode: 'usps_ground_advantage',
    carrierStatuses: [{ carrierId: 'se-433542', status: 'cached', rateCount: 4 }],
  }).action === 'blocked');

check('clean no-rate response clears saved best rate',
  planStrictRecalculateDecision({
    liveBestAmount: null,
    providerAccountId: null,
    serviceCode: null,
    carrierStatuses: [
      { carrierId: 'se-433542', status: 'unavailable', rateCount: 0 },
      { carrierId: 'se-10000007', status: 'unavailable', rateCount: 0 },
    ],
  }).action === 'clear');

check('missing provider account blocks update',
  planStrictRecalculateDecision({
    liveBestAmount: 7.45,
    providerAccountId: null,
    serviceCode: 'usps_ground_advantage',
    carrierStatuses: [{ carrierId: 'se-433542', status: 'live', rateCount: 4 }],
  }).action === 'blocked');
check('missing service blocks update',
  planStrictRecalculateDecision({
    liveBestAmount: 7.45,
    providerAccountId: 433542,
    serviceCode: null,
    carrierStatuses: [{ carrierId: 'se-433542', status: 'live', rateCount: 4 }],
  }).action === 'blocked');

// PS-178 final part: the FE never decides — the applier consumes ONLY the
// backend verdict, and a response without one is BLOCKED (no local plan).
{
  const ordersViewSrc = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
  check('FE consumes the backend strictRecalculation verdict only (local plan deleted)',
    /toRecord\(response\?\.strictRecalculation\)/.test(ordersViewSrc) &&
    !/planStrictBestRateRecalculate/.test(ordersViewSrc) &&
    /did not return a backend verdict/.test(ordersViewSrc));
}

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// PS-135: proof candidate-selection logic moved to the canonical lib; OrdersView delegates.
const rateProof = readFileSync('web/src/lib/rate-proof.ts', 'utf8');
const recalcStart = ordersView.indexOf('async function recalculateBestRate(');
const recalcEnd = ordersView.indexOf('\n  function applyRateSelection', recalcStart);
const recalcBlock = recalcStart >= 0 && recalcEnd > recalcStart
  ? ordersView.slice(recalcStart, recalcEnd)
  : '';
const runnerStart = ordersView.indexOf('async function runStrictBestRateRecalculation(');
const runnerEnd = ordersView.indexOf('\n  function getAppliedRateDims', runnerStart);
const runnerBlock = runnerStart >= 0 && runnerEnd > runnerStart
  ? ordersView.slice(runnerStart, runnerEnd)
  : '';
const applierStart = ordersView.indexOf('async function applyStrictBestRateResponse(');
const applierEnd = ordersView.indexOf('\n  async function runStrictBestRateRecalculation', applierStart);
const applierBlock = applierStart >= 0 && applierEnd > applierStart
  ? ordersView.slice(applierStart, applierEnd)
  : '';
const proofBuilderStart = ordersView.indexOf('function buildSelectedRateProofPayload(');
const proofBuilderEnd = ordersView.indexOf('\n  function hasAnySavedBestRateForDisplay', proofBuilderStart);
const proofBuilderBlock = proofBuilderStart >= 0 && proofBuilderEnd > proofBuilderStart
  ? ordersView.slice(proofBuilderStart, proofBuilderEnd)
  : '';
const panelRefreshStart = ordersView.indexOf('async function refreshPanelBestRate(');
const panelRefreshEnd = ordersView.indexOf('\n  async function persistShipmentDetails', panelRefreshStart);
const panelRefreshBlock = panelRefreshStart >= 0 && panelRefreshEnd > panelRefreshStart
  ? ordersView.slice(panelRefreshStart, panelRefreshEnd)
  : '';
const batchActionStart = ordersView.indexOf("async function handleBatchAction(mode: 'print' | 'queue')");
const batchActionEnd = ordersView.indexOf('\n  // Batch Mark-as-Shipped', batchActionStart);
const batchActionBlock = batchActionStart >= 0 && batchActionEnd > batchActionStart
  ? ordersView.slice(batchActionStart, batchActionEnd)
  : '';
const strictPathBlock = `${recalcBlock}\n${runnerBlock}\n${applierBlock}`;

check('OrdersView has a Recalculate action', recalcStart >= 0);
check('Recalculate delegates to reusable strict runner', /runStrictBestRateRecalculation/.test(recalcBlock));
check('Recalculate uses browseRates strict live endpoint', /apiClient\.browseRates\(\{[\s\S]*forceLive:\s*true[\s\S]*forceRefresh:\s*true/.test(strictPathBlock));
check('Recalculate does not use fetchRates', !/apiClient\.fetchRates/.test(strictPathBlock));
check('Recalculate does not pick a client-side fallback best rate', !/pickBestPanelRate/.test(strictPathBlock));
check('Recalculate records exact-key blocked/clear table entries', /setAutoBestRateEntries/.test(applierBlock) && /decision\.entry/.test(applierBlock));
check('Selected-rate proof only accepts backend-issued proof metadata',
  // PS-135: candidate selection lives in selectProofFromCandidates (rate-proof.ts); the
  // OrdersView builder delegates to it.
  /hasBackendIssuedRateProof\(rate\) && rateProofFingerprint\(rate\)/.test(rateProof) &&
    /selectProofFromCandidates\(/.test(proofBuilderBlock));
check('Panel refreshed best rate is stamped with request fingerprint metadata before label proof',
  /const bestRateWithMetadata = autoRequest\s*\?\s*withRateRequestMetadata\(bestRate, autoRequest/.test(panelRefreshBlock) &&
    /setPanelRatePreview\(\[bestRateWithMetadata\]\)/.test(panelRefreshBlock) &&
    /persistAppliedRateForOrder\(order\.orderId, bestRateWithMetadata/.test(panelRefreshBlock));
check('Batch Create + Print recalculates missing selected-rate proof before label purchase',
  /let proofRate = bestRate \?\? selectedRate/.test(batchActionBlock) &&
    /if \(!selectedRateProof && !orderIsTest\)/.test(batchActionBlock) &&
    /runStrictBestRateRecalculation\(order, proofRequest/.test(batchActionBlock) &&
    /selectedRateProof = buildSelectedRateProofPayload\(order, proofRate\)/.test(batchActionBlock) &&
    /selectedRateProof,/.test(batchActionBlock));
check('Rate card button is labeled Recalculate', />Recalculate</.test(ordersView));
check('Rate card Recalculate button calls recalculateBestRate, not openRateBrowser', /onClick=\{\(\) => void recalculateBestRate\(\)\}/.test(ordersView));

const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const strictStart = apiClient.indexOf('updateOrderBestRateSelectionStrict(');
const strictEnd = apiClient.indexOf('createManualOrder(', strictStart);
const strictBlock = strictStart >= 0 && strictEnd > strictStart
  ? apiClient.slice(strictStart, strictEnd)
  : '';
check('apiClient exposes strict best-rate selection updater', strictStart >= 0);
check('strict updater uses direct api.patch', /api\.patch<any>\(`\/orders\/\$\{orderId\}`/.test(strictBlock));
check('strict updater is not wrapped in safe fallback', !/safe\(/.test(strictBlock));
check('rate browse in-flight key includes insurance fields for strict request identity',
  /'insuranceProvider'/.test(apiClient) && /'insuredValue'/.test(apiClient));

if (failures > 0) {
  console.error(`\nFAIL recalculate best-rate strict guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS recalculate best-rate strict guard');
