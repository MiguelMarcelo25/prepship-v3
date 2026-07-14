#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  HUGRAB_GROUND_SAVER_BLOCK_REASON,
  SHIPPING_SERVICE_ELIGIBILITY_VERSION,
  assertShippingServiceEligible,
  describeShippingService,
  evaluateShippingServiceEligibility,
  filterEligibleShippingServices,
  isHugrabShippingContext,
  isUpsGroundSaverOrSurePostService,
} from '../src/lib/shipping-service-eligibility';

const hugrabByClientId = { clientId: 4, clientName: null, storeId: null };
const hugrabByStoreId = { clientId: null, clientName: null, storeId: 378060 };
const hugrabByName = { clientId: null, clientName: '  hug rab  ', storeId: null };
const otherClient = { clientId: 99, clientName: 'Not HUGRAB', storeId: 999999 };

assert.equal(
  SHIPPING_SERVICE_ELIGIBILITY_VERSION,
  'ps-057-hugrab-ground-saver-v1|po-box-v1',
  'eligibility version must be stable and explicit for cache invalidation',
);

assert.equal(isHugrabShippingContext(hugrabByClientId), true, 'client #4 must be recognized as HUGRAB');
assert.equal(isHugrabShippingContext(hugrabByStoreId), true, 'store #378060 must be recognized as HUGRAB');
assert.equal(isHugrabShippingContext(hugrabByName), true, 'normalized HUGRAB name fallback must work');
assert.equal(isHugrabShippingContext(otherClient), false, 'other clients must not be treated as HUGRAB');

for (const serviceCode of [
  'ups_ground_saver',
  'ups_surepost',
  'ups_surepost_1_lb_or_greater',
  'ups_surepost_less_than_1_lb',
  'easypost_ups_upsdap_upsgroundsavergreaterthan1lb',
  '92',
  '93',
]) {
  const eligibility = evaluateShippingServiceEligibility(hugrabByClientId, {
    carrierCode: 'ups',
    serviceCode,
    serviceName: 'UPS Ground Saver',
  });
  assert.equal(eligibility.allowed, false, `${serviceCode} must be blocked for HUGRAB`);
  assert.equal(eligibility.reason, HUGRAB_GROUND_SAVER_BLOCK_REASON);
}

assert.equal(
  isUpsGroundSaverOrSurePostService({
    carrierCode: 'ups',
    serviceCode: 'provider_specific_eco',
    serviceName: 'UPS SurePost Residential',
  }),
  true,
  'provider-specific names containing SurePost must be detected',
);
assert.equal(
  isUpsGroundSaverOrSurePostService({
    carrierCode: 'ups',
    serviceCode: 'provider_specific_eco',
    serviceName: 'UPSDAP UPSGroundsaverGreaterThan1lb',
  }),
  true,
  'provider service names containing normalized no-space GroundSaver must be detected',
);
assert.equal(
  isUpsGroundSaverOrSurePostService({
    carrierCode: 'ups',
    serviceCode: 'provider_specific_eco',
    serviceType: 'UPSGroundsaverGreaterThan1lb',
  }),
  true,
  'provider service type containing normalized no-space GroundSaver must be detected',
);
assert.equal(
  isUpsGroundSaverOrSurePostService({
    carrierCode: 'ups',
    serviceCode: 'easypost_ups_upsdap_upsgroundsavergreaterthan1lb',
    serviceName: 'UPSDAP UPSGroundsaverGreaterThan1lb',
  }),
  true,
  'EasyPost UPSDAP normalized GroundSaver code must be detected',
);
assert.equal(
  evaluateShippingServiceEligibility(
    hugrabByClientId,
    describeShippingService({
      carrierCode: 'ups',
      serviceCode: 'easypost ups upsdap upsgroundsavergreaterthan1lb',
      serviceName: 'UPS Ground Saver (1 lb or greater)',
      raw: { service_type: 'SurePost' },
    }),
  ).allowed,
  false,
  'persisted camelCase/raw saved-rate JSON must be detected and invalidated',
);
assert.equal(
  evaluateShippingServiceEligibility(hugrabByClientId, {
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    serviceName: 'UPS Ground',
  }).allowed,
  true,
  'HUGRAB UPS Ground must remain allowed',
);
assert.equal(
  evaluateShippingServiceEligibility(hugrabByClientId, {
    carrierCode: 'ups',
    serviceCode: '02',
    serviceName: 'UPS 2nd Day Air',
  }).allowed,
  true,
  'HUGRAB UPS 2nd Day Air must remain allowed',
);
assert.equal(
  evaluateShippingServiceEligibility(otherClient, {
    carrierCode: 'ups',
    serviceCode: 'ups_ground_saver',
    serviceName: 'UPS Ground Saver',
  }).allowed,
  true,
  'non-HUGRAB Ground Saver must remain allowed',
);

assert.throws(
  () =>
    assertShippingServiceEligible(hugrabByClientId, {
      carrierCode: 'ups',
      serviceCode: 'ups_surepost',
      serviceName: 'UPS Ground Saver',
    }),
  /UPS Ground Saver is disabled for HUGRAB orders/,
  'label creation guard must throw the operator-readable message',
);

const rankedRates = filterEligibleShippingServices(
  [
    { serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver', cost: 5 },
    { serviceCode: 'ups_ground', serviceName: 'UPS Ground', cost: 7 },
  ],
  hugrabByClientId,
  (rate) => ({
    carrierCode: 'ups',
    serviceCode: rate.serviceCode,
    serviceName: rate.serviceName,
  }),
);
assert.deepEqual(
  rankedRates.map((rate) => rate.serviceCode),
  ['ups_ground'],
  'rate filtering must remove stale/cached Ground Saver and keep the next valid service',
);

const sourceChecks: Array<[string, string[]]> = [
  [
    'src/services/rates.ts',
    [
      'filterEligibleShippingServices',
      'SHIPPING_SERVICE_ELIGIBILITY_VERSION',
      'eligibilityReason',
    ],
  ],
  [
    'src/routes/rates.ts',
    [
      'selectRateCachePublicRowsByKeys',
      'isMissingRateCacheDiagnosticsColumnError',
      'rate_cache.diagnostics column missing',
    ],
  ],
  [
    'src/routes/orders.ts',
    [
      'sanitizeAwaitingOverridesForShippingEligibility',
      'SHIPPING_SERVICE_NOT_ELIGIBLE',
      'order_overrides.best_rate_json',
    ],
  ],
  [
    'src/services/rates-backfill.ts',
    [
      'savedBestRateNeedsEligibilityRefresh',
      'ineligibleSavedRatePredicate',
      'SHIPPING_SERVICE_ELIGIBILITY_VERSION',
      'ground saver',
    ],
  ],
  [
    'src/services/order-rate-dto.ts',
    [
      'eligibilityVersion',
      'cacheExpiresAt',
    ],
  ],
  [
    'src/services/labels.ts',
    [
      'assertShippingServiceEligible',
      'serviceCode: body.serviceCode',
      'serviceName: body.serviceName ?? body.serviceCode',
      'serviceCode: input.serviceCode',
    ],
  ],
  [
    'src/services/carrier-connector-orchestrator.ts',
    [
      'assertShippingServiceEligible',
      'CarrierLabelInput',
    ],
  ],
  [
    'api/carriers/rates.ts',
    [
      'filterEligibleShippingServices',
      'clientId',
      'storeId',
    ],
  ],
  // PS-209 re-anchor: the legacy Vercel label endpoint is a retired
  // no-import 410 — it cannot buy postage, so the Ground-Saver eligibility
  // gate there is moot (the v4 owner's gate is pinned above). The stub-shape
  // pin keeps purchase machinery from creeping back.
  [
    'api/carriers/labels.ts',
    [
      'LEGACY_LABEL_ENDPOINT_RETIRED',
    ],
  ],
  [
    'web/src/components/RateBrowserModal.tsx',
    [
      'rateBrowserUnavailableReason',
      'eligibilityBlocked',
      'eligibilityBlockReason',
      'HUGRAB_GROUND_SAVER_BLOCK_REASON',
      'rateBlockedReason',
    ],
  ],
  [
    'web/src/components/Views/orders-panel-state.ts',
    [
      'isEligiblePanelService',
      'getInitialPanelServiceCode',
      'evaluateShippingServiceEligibility',
    ],
  ],
  [
    'web/src/components/Views/OrdersView.tsx',
    [
      'SHIPPING_SERVICE_ELIGIBILITY_VERSION',
      'eligibilityVersion',
      'savedRateIsFreshAndComplete',
    ],
  ],
  [
    'web/src/lib/v2-apiClient.ts',
    [
      'clientName',
      'storeId',
      'clientId',
    ],
  ],
];

for (const [file, needles] of sourceChecks) {
  const source = readFileSync(file, 'utf8');
  for (const needle of needles) {
    assert.ok(source.includes(needle), `${file} must include ${needle}`);
  }
}

console.log('PASS PS-057 HUGRAB Ground Saver/SurePost eligibility guard');
