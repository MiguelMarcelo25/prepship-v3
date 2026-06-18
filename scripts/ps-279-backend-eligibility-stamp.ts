/**
 * PS-279 (backend-ownership pillar) — the rate BLOCK/eligibility REASON is BACKEND-owned.
 *
 * Architecture-first: the FE-owned block-list reason (rateBlockedReason →
 * evaluateShippingServiceEligibility) is a money/eligibility VERDICT and must live at the rate
 * source of truth. This slice stamps that verdict onto the order-rate DTO (order-rate-dto.ts)
 * via a single pure resolver (shipping-workflow/rate-eligibility-stamp), so the Rate Browser
 * READS the backend verdict instead of re-deriving it. The FE keeps its own
 * evaluateShippingServiceEligibility call ONLY as a deploy-skew fallback for older payloads.
 *
 *   npx tsx scripts/ps-279-backend-eligibility-stamp.ts
 */
import { readFileSync } from 'node:fs';
import { resolveRateEligibilityStamp } from '../src/services/shipping-workflow/rate-eligibility-stamp';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';
import { HUGRAB_GROUND_SAVER_BLOCK_REASON } from '../src/lib/shipping-service-eligibility';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. the pure resolver delegates to the canonical eligibility owner ──
check('resolveRateEligibilityStamp ALLOWS an ordinary rate (no block)', (() => {
  const stamp = resolveRateEligibilityStamp({
    context: { clientId: 999, clientName: 'acme', storeId: 1 },
    service: { carrierCode: 'ups', serviceCode: 'ups_ground', serviceName: 'UPS Ground' },
  });
  return stamp.eligibilityBlocked === false && stamp.eligibilityBlockReason === null;
})());

check('resolveRateEligibilityStamp BLOCKS HUGRAB UPS Ground Saver with the canonical reason', (() => {
  const stamp = resolveRateEligibilityStamp({
    context: { clientId: 4, clientName: 'HUGRAB', storeId: 378060 },
    service: { carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver' },
  });
  return stamp.eligibilityBlocked === true && stamp.eligibilityBlockReason === HUGRAB_GROUND_SAVER_BLOCK_REASON;
})());

// ── 2. the DTO STAMPS the verdict (backend-side) when an eligibility context is supplied ──
check('normalizeOrderBestRateDto stamps eligibilityBlocked/eligibilityBlockReason for a blocked HUGRAB Ground Saver best', (() => {
  const dto = normalizeOrderBestRateDto(
    { serviceCode: 'ups_ground_saver', carrierCode: 'ups', shipmentCost: 5, otherCost: 0 },
    'bestRate',
    { eligibility: { clientId: 4, clientName: 'HUGRAB', storeId: 378060 } },
  );
  return dto != null && dto.eligibilityBlocked === true && dto.eligibilityBlockReason === HUGRAB_GROUND_SAVER_BLOCK_REASON;
})());

check('normalizeOrderBestRateDto leaves an ordinary best UNBLOCKED', (() => {
  const dto = normalizeOrderBestRateDto(
    { serviceCode: 'ups_ground', carrierCode: 'ups', shipmentCost: 8, otherCost: 0 },
    'bestRate',
    { eligibility: { clientId: 999, clientName: 'acme', storeId: 1 } },
  );
  return dto != null && dto.eligibilityBlocked === false && dto.eligibilityBlockReason === null;
})());

check('normalizeOrderBestRateDto defaults to UNBLOCKED when no eligibility context is given (backward compatible)', (() => {
  const dto = normalizeOrderBestRateDto({ serviceCode: 'ups_ground', carrierCode: 'ups', shipmentCost: 8, otherCost: 0 });
  return dto != null && dto.eligibilityBlocked === false && dto.eligibilityBlockReason === null;
})());

// ── 3. the DTO type + normalizer source actually delegate to the resolver (no inline re-derivation) ──
const dtoSrc = readFileSync('src/services/order-rate-dto.ts', 'utf8');
check('order-rate-dto declares the eligibilityBlocked field on OrderBestRateDto',
  /eligibilityBlocked:\s*boolean/.test(dtoSrc));
check('order-rate-dto declares the eligibilityBlockReason field on OrderBestRateDto',
  /eligibilityBlockReason:\s*string\s*\|\s*null/.test(dtoSrc));
check('order-rate-dto imports resolveRateEligibilityStamp from the workflow resolver',
  /import\s*\{[^}]*\bresolveRateEligibilityStamp\b[^}]*\}\s*from\s*'\.\/shipping-workflow\/rate-eligibility-stamp'/.test(dtoSrc));

// ── 4. the FE PREFERS the backend stamp and keeps its own evaluator only as a deploy-skew fallback ──
const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
check('modal reads a backend-stamped eligibilityBlockReason/eligibilityBlocked from the rate',
  /eligibilityBlockReason|eligibilityBlocked/.test(modal));
// The deploy-skew fallback must remain: the FE still calls evaluateShippingServiceEligibility.
check('modal RETAINS evaluateShippingServiceEligibility as the deploy-skew fallback',
  /evaluateShippingServiceEligibility\(/.test(modal));

// ── 5. package.json wires the new test script ──
check('package.json wires test:ps-279-backend-eligibility-stamp',
  /test:ps-279-backend-eligibility-stamp/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-279 backend eligibility stamp guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-279 backend eligibility stamp guard');
