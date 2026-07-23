/**
 * PS-302 guard - Apply Best Rate authority stays backend-owned.
 *
 * Backend producers mint quote proof ({ rateQuoteId, selectedRateKey,
 * proofSource }); Rate Browser and translators only pass those fields through;
 * label/queue purchase validates them at the backend boundary. Offline only:
 * no DB, no network, no providers, no labels, no postage, no marketplace calls.
 */
import { readFileSync } from 'node:fs';
import {
  rateQuoteRefFromCandidates,
  selectProofFromCandidates,
} from '../web/src/lib/rate-proof';

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
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const backendIssued = {
  rateQuoteId: 'rq_backend_302',
  selectedRateKey: 'srk_backend_302',
  selectionRef: 'sqa_backend_302',
  proofSource: 'backend_rate_response',
  requestFingerprint: 'fp_backend_302',
  serviceCode: 'ups_ground',
  shippingProviderId: 607855,
};
const legacyProof = {
  proofSource: 'backend_rate_response',
  requestFingerprint: 'fp_legacy_302',
  serviceCode: 'usps_ground_advantage',
  shippingProviderId: 607855,
};

check('frontend proof helper prefers backend selectionRef when present',
  JSON.stringify(rateQuoteRefFromCandidates([backendIssued, legacyProof])) ===
    JSON.stringify({ selectionRef: 'sqa_backend_302' }));
check('frontend proof helper does not synthesize a snapshot ref from legacy proof',
  JSON.stringify(rateQuoteRefFromCandidates([legacyProof])) === JSON.stringify({}));
check('frontend proof helper rejects half refs instead of fabricating the missing key',
  JSON.stringify(rateQuoteRefFromCandidates([{ rateQuoteId: 'rq_half' }, legacyProof])) ===
    JSON.stringify({}));
check('frontend legacy proof helper only selects backend-stamped proof',
  selectProofFromCandidates([{ requestFingerprint: 'fp_without_source' }, legacyProof])?.requestFingerprint === 'fp_legacy_302');
check('frontend account filter prevents applying proof from a different account',
  JSON.stringify(rateQuoteRefFromCandidates([
    { ...backendIssued, shippingProviderId: 111111 },
    legacyProof,
  ], { forShippingProviderId: 607855 })) === JSON.stringify({}));

const rateStore = read('src/services/shipping-workflow/rate-quote-snapshot-store.ts');
check('single backend finalizer returns bestRate, rates, and rateQuoteId',
  /export async function finalizeBestRateWithQuote/.test(rateStore) &&
  /bestRate: T & \{[\s\S]{0,220}selectedRateKey: string;[\s\S]{0,220}rateQuoteId\?: string;[\s\S]{0,220}proofSource: string;[\s\S]{0,220}isComplete: boolean;/.test(rateStore) &&
  /rates: Array<Record<string, unknown> & \{[\s\S]{0,220}selectedRateKey: string;[\s\S]{0,220}rateQuoteId\?: string;[\s\S]{0,220}proofSource: string;[\s\S]{0,220}isComplete: boolean;/.test(rateStore) &&
  /rateQuoteId\?: string/.test(rateStore));
check('single backend finalizer stamps backend proof source',
  /proofSource: BACKEND_RATE_PROOF_SOURCE/.test(rateStore) &&
  /BACKEND_RATE_PROOF_SOURCE = 'backend_rate_response'/.test(rateStore));
check('single backend finalizer stamps selectionRef and backend completeness onto authorized rates',
  /const isComplete = input\.bestRateComplete === true/.test(rateStore) &&
  /const selectionRefFor =/.test(rateStore) &&
  /\.\.\.\(selectionRef \? \{ selectionRef \} : \{\}\)/.test(rateStore) &&
  /proofSource: BACKEND_RATE_PROOF_SOURCE/.test(rateStore) &&
  /isComplete,/.test(rateStore));

const ratesRoute = read('src/routes/rates.ts');
const rateBrowseProducer = read('src/services/rate-browse-response-producer.ts');
check('/rates/browse delegates best-rate proof minting to finalizeBestRateWithQuote',
  /produceRateBrowsePayload/.test(ratesRoute) &&
  /const finalized = await finalizeBestRateWithQuote\(\{/.test(rateBrowseProducer) &&
  /rateQuoteId = finalized\.rateQuoteId/.test(rateBrowseProducer) &&
  /responseRates = finalized\.rates/.test(rateBrowseProducer));
check('/rates/browse does not reimplement snapshot storage inline',
  !/const ratesWithKeys = withSelectedRateKeys\(combinedRates\)[\s\S]{0,160}storeRateQuoteSnapshot\(\{/.test(ratesRoute));
check('/rates/browse attaches backend-issued proofSource only from backend constants',
  rateBrowseProducer.includes("import {") &&
  rateBrowseProducer.includes('BACKEND_RATE_PROOF_SOURCE') &&
  rateBrowseProducer.includes('proofSource: BACKEND_RATE_PROOF_SOURCE'));

const backfill = read('src/services/rates-backfill.ts');
check('rates backfill also delegates best-rate proof minting to the same backend finalizer',
  /const \{ bestRate: finalizedBest \} = await finalizeBestRateWithQuote\(\{/.test(backfill));
check('rates backfill stamps second-best metadata from backend constants, not frontend',
  /proofSource: BACKEND_RATE_PROOF_SOURCE/.test(backfill) &&
  /selectedRateKey: selectedRateOpaqueKey\(secondBest\)/.test(backfill));

const modal = read('web/src/components/RateBrowserModal.tsx');
check('Rate Browser Apply uses rateBackendProof pass-through helper',
  /function rateBackendProof\(r: RateRow\)/.test(modal));
check('manual Apply Best Rate spreads backend proof fields verbatim',
  (() => {
    const start = modal.indexOf('function handleRateClick(');
    const end = modal.indexOf('onClose();', start);
    const block = start >= 0 && end > start ? modal.slice(start, end) : '';
    return block.includes('...rateBackendProof(r)');
  })());
check('canonical auto-apply spreads backend proof fields verbatim',
  (() => {
    const start = modal.indexOf('function toAppliedRate(');
    const end = modal.indexOf('return {', start);
    const close = modal.indexOf('  }', end);
    const block = start >= 0 && close > start ? modal.slice(start, close) : '';
    return block.includes('...rateBackendProof(r)');
  })());
check('Rate Browser proof helper is pass-through only and does not mint proofSource',
  (() => {
    const start = modal.indexOf('function rateBackendProof(');
    const end = modal.indexOf('\n  }', start);
    const block = start >= 0 && end > start ? modal.slice(start, end) : '';
    return block.includes("const value = (r as Record<string, unknown>)[key] ?? raw?.[key] ?? canonical?.[key]") &&
      !/proofSource\s*[:=]\s*['"`]/.test(block);
  })());

const shared = read('web/src/lib/v2-apiClient/shared.ts');
check('rate translation passes backend proof fields through without inventing ids',
  /requestFingerprint:\s*obj\.requestFingerprint\s*\?\?\s*null/.test(shared) &&
  /proofSource:\s*obj\.proofSource\s*\?\?\s*null/.test(shared) &&
  /rateQuoteId:\s*obj\.rateQuoteId\s*\?\?\s*null/.test(shared) &&
  /selectedRateKey:\s*obj\.selectedRateKey\s*\?\?\s*null/.test(shared) &&
  /selectionRef:\s*obj\.selectionRef\s*\?\?\s*null/.test(shared) &&
  !/rateQuoteId:\s*['"`]/.test(shared) &&
  !/selectedRateKey:\s*['"`]/.test(shared));

const rateProof = read('web/src/lib/rate-proof.ts');
check('frontend proof helper is read-only: no hashing/fingerprint construction imports',
  !rateProof.includes('createHash') &&
  !rateProof.includes('buildShippingRateRequestFingerprint') &&
  !rateProof.includes('selectedRateAuthorityKey'));
check('frontend proof helper describes itself as pass-through',
  rateProof.includes('PURE reads of a backend-issued rate record') &&
  rateProof.includes('NEVER recompute a fingerprint'));

const ordersRoute = read('src/routes/orders.ts');
const ordersCommand = read('src/services/orders-overrides-command.ts');
check('Apply Best Rate service canonicalizes and validates persisted best-rate DTO',
  /export async function saveBestRateForOrder\(/.test(ordersCommand) &&
  ordersCommand.includes("assertPersistedOrderBestRateDto(body.bestRateJson, 'bestRateJson')") &&
  ordersCommand.includes('validateBestRateDimsForPersistedRate(') &&
  ordersCommand.includes('shippingRateEligibilityReason('));
check('Apply Best Rate route guards then delegates without owning proof or persistence',
  (() => {
    const match = /app\.post\(\s*['"]\/:id\{\[0-9\]\+\}\/best-rate['"]/.exec(ordersRoute);
    const start = match?.index ?? -1;
    const end = start >= 0 ? ordersRoute.indexOf('app.post(', start + 10) : -1;
    const block = start >= 0 ? ordersRoute.slice(start, end > start ? end : start + 3000) : '';
    return block.indexOf('assertOrderEditable(c, id)') >= 0 &&
      block.indexOf('assertOrderEditable(c, id)') < block.indexOf('saveBestRateForOrder(') &&
      !/proofSource:\s*BACKEND_RATE_PROOF_SOURCE/.test(block) &&
      !/rateQuoteId:\s*deriveRateQuoteId/.test(block) &&
      !/selectedRateKey:\s*selectedRateOpaqueKey/.test(block) &&
      !/db\.|assertPersistedOrderBestRateDto\(|houseTupleStatus\(/.test(block);
  })());

const labels = read('src/services/labels.ts');
check('label creation validates applied best-rate proof before provider purchase',
  /await assertLabelPurchaseRateSelection\(\{/.test(labels) &&
  /selectionRef:\s*body\.selectionRef/.test(labels) &&
  /assertShippingQuoteContextMatches\(\{/.test(labels) &&
  /assertShippingQuoteAccountMatches\(\{/.test(labels));

const workflowDoc = read('docs/ps-tickets/ps-300-active-lawrence-execution-workflow.md');
check('workflow doc records PS-302 apply-best-rate authority guard',
  workflowDoc.includes('test:ps-302-apply-best-rate-authority'));

const packageJson = read('package.json');
check('package wires PS-302 apply-best-rate authority guard',
  /"test:ps-302-apply-best-rate-authority"\s*:\s*"tsx scripts\/ps-302-apply-best-rate-authority-guard\.ts"/.test(packageJson));
check('package still wires PS-198 and PS-244 predecessor guards',
  packageJson.includes('"test:ps-198-rate-quote-proof-passthrough"') &&
  packageJson.includes('"test:ps-244-rate-finalization-single-owner"'));

if (failures > 0) {
  console.error(`\nFAIL PS-302 Apply Best Rate authority guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-302 Apply Best Rate authority guard');
