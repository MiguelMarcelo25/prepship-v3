/**
 * Guard: saved best-rate records must stay displayable after backend persistence.
 *
 * Read-only: pure DTO/UI contract checks only. No DB, no carrier APIs, no labels.
 */
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';
import { savedBestRateCanDisplayForCurrentRequest } from '../web/src/components/Views/orders-parity';

let failures = 0;

function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const normalized = normalizeOrderBestRateDto({
  serviceCode: 'ups_surepost_1_lb_or_greater',
  serviceName: 'UPS Ground Saver (1 lb+)',
  carrierCode: 'ups',
  shipmentCost: 7.78,
  clientRequestKey: '1212525|v=ground-saver-v2|w=220|z=33018|l=80|dw=60|h=60',
  requestFingerprint: 'v=ground-saver-v2|w=220|z=33018|l=80|dw=60|h=60|c=se-433542',
  cacheKey: 'v=ground-saver-v2|w=220|z=33018|l=80|dw=60|h=60|c=se-433542',
  proofSource: 'backend_rate_snapshot',
  rateQuoteId: 'rq_saved_display_contract',
  selectedRateKey: 'srk_saved_display_contract',
  cacheExpiresAt: '2026-06-06T12:00:00.000Z',
  eligibilityVersion: 'ground-saver-v2',
  isComplete: true,
  rateCount: 86,
  matchType: 'live',
});

check('normalizer preserves client request key', normalized?.clientRequestKey, '1212525|v=ground-saver-v2|w=220|z=33018|l=80|dw=60|h=60');
check('normalizer preserves backend proof source', normalized?.proofSource, 'backend_rate_snapshot');
check('normalizer preserves rate quote id', normalized?.rateQuoteId, 'rq_saved_display_contract');
check('normalizer preserves selected rate key', normalized?.selectedRateKey, 'srk_saved_display_contract');

check(
  'frontend key match remains displayable',
  savedBestRateCanDisplayForCurrentRequest({
    clientRequestKey: 'order|current',
    requestKey: 'order|current',
    hasBackendIssuedRateProof: true,
    isComplete: true,
    cacheExpiresAt: '2026-06-06T12:00:00.000Z',
    nowMs: Date.parse('2026-06-06T05:30:00.000Z'),
    eligibilityVersion: 'ground-saver-v2',
    requiredEligibilityVersion: 'ground-saver-v2',
    baseAmount: 7.78,
  }),
  true,
);

check(
  'backend fresh workflow makes older persisted rate displayable',
  savedBestRateCanDisplayForCurrentRequest({
    clientRequestKey: null,
    requestKey: 'order|current',
    hasBackendIssuedRateProof: true,
    isComplete: true,
    cacheExpiresAt: '2026-06-06T12:00:00.000Z',
    nowMs: Date.parse('2026-06-06T05:30:00.000Z'),
    eligibilityVersion: 'ground-saver-v2',
    requiredEligibilityVersion: 'ground-saver-v2',
    baseAmount: 7.78,
    backendWorkflowCanUseSavedRate: true,
  }),
  true,
);

check(
  'missing client key without backend fresh workflow is not displayable',
  savedBestRateCanDisplayForCurrentRequest({
    clientRequestKey: null,
    requestKey: 'order|current',
    hasBackendIssuedRateProof: true,
    isComplete: true,
    cacheExpiresAt: '2026-06-06T12:00:00.000Z',
    nowMs: Date.parse('2026-06-06T05:30:00.000Z'),
    eligibilityVersion: 'ground-saver-v2',
    requiredEligibilityVersion: 'ground-saver-v2',
    baseAmount: 7.78,
  }),
  false,
);

if (failures > 0) {
  console.error(`\nFAIL saved best-rate display contract guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS saved best-rate display contract guard');
