/**
 * PS-433 adversarial rate-authority proof.
 *
 * Offline only: exercises the real backend proof/account policy owners with an
 * injected provider spy. It does not open a database, call a provider, buy
 * postage, create a label, or mutate shipped/cancelled data.
 */
import assert from 'node:assert/strict';

// Seed an inert environment before loading backend owners. This behavior proof
// uses injected data only and must never inherit live DB credentials.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://ps433:offline@127.0.0.1:1/ps433';
process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_ANON_KEY = 'offline';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline';
process.env.SUPABASE_JWT_SECRET = 'offline';

const { evaluateClientRateSourcePolicy } = await import(
  '../src/services/client-rate-source-policy.js'
);
const {
  buildApplyBestRatePatch,
  finalizeAppliedBestRateFromSnapshot,
} = await import('../src/services/shipping-workflow/apply-best-rate.js');
const { assertPurchaseAccountMatchesProof } = await import(
  '../src/services/shipping-workflow/rate-fingerprint.js'
);
const { normalizeOrderBestRateDto } = await import('../src/services/order-rate-dto.js');

const fetchedAt = '2026-07-15T08:00:00.000Z';
const now = Date.parse('2026-07-15T09:00:00.000Z');
const order101Rate = {
  carrier_id: 'se-596001',
  carrier_code: 'ups',
  service_code: 'ups_ground',
  service_type: 'UPS Ground',
  shipping_amount: { amount: 9.65, currency: 'USD' },
  other_amount: { amount: 0, currency: 'USD' },
  amount: 9.65,
  shipmentCost: 9.65,
  otherCost: 0,
  selectedRateKey: 'srk-order-101',
};
const order101Snapshot = {
  cacheKey: 'rate:v4|order=101|account=596001|dims=12x10x6|weight=32',
  rates: [order101Rate],
  fetchedAt,
  bestRateKey: order101Rate.selectedRateKey,
  bestRateComplete: true,
};

let providerSpyCalls = 0;

function attemptProviderPurchase(input: {
  selectedRateKey: string;
  purchaseShippingProviderId: number;
}): { ok: true } | { ok: false; code: string } {
  const finalized = finalizeAppliedBestRateFromSnapshot({
    rateQuoteId: 'rq-order-101',
    selectedRateKey: input.selectedRateKey,
    snapshot: order101Snapshot,
    now,
  });
  if (!finalized.ok) return { ok: false, code: finalized.code };

  try {
    assertPurchaseAccountMatchesProof({
      purchaseShippingProviderId: input.purchaseShippingProviderId,
      selectedRate: finalized.bestRateJson,
    });
  } catch (error) {
    return {
      ok: false,
      code: String((error as Error & { code?: string }).code ?? 'account_mismatch'),
    };
  }

  const patch = buildApplyBestRatePatch({
    bestRateJson: finalized.bestRateJson,
    dimsLabel: '12x10x6',
    selectedPid: 44,
    currentRequestFingerprint: order101Snapshot.cacheKey,
  });
  if (!patch.ok) return { ok: false, code: patch.code };

  providerSpyCalls += 1;
  return { ok: true };
}

const crossOrder = attemptProviderPurchase({
  selectedRateKey: 'srk-order-202',
  purchaseShippingProviderId: 596001,
});
assert.deepEqual(crossOrder, { ok: false, code: 'selected_rate_not_found' });
assert.equal(providerSpyCalls, 0, 'cross-order quote rejection must not reach the provider spy');

const crossAccount = attemptProviderPurchase({
  selectedRateKey: order101Rate.selectedRateKey,
  purchaseShippingProviderId: 700002,
});
assert.equal(crossAccount.ok, false);
assert.equal(providerSpyCalls, 0, 'cross-account proof rejection must not reach the provider spy');

const factMismatch = buildApplyBestRatePatch({
  bestRateJson: {
    ...order101Rate,
    requestFingerprint: order101Snapshot.cacheKey,
  },
  dimsLabel: '12x10x6',
  selectedPid: 44,
  currentRequestFingerprint: 'rate:v4|order=101|account=596001|dims=20x20x20|weight=32',
});
assert.deepEqual(factMismatch, {
  ok: false,
  code: 'fingerprint_mismatch',
  error: 'The best rate was quoted against a different request; re-rate before applying.',
});
assert.equal(providerSpyCalls, 0, 'fact mismatch must not reach the provider spy');

assert.deepEqual(
  evaluateClientRateSourcePolicy({
    clientId: 10,
    rateSourceClientId: 20,
    source: { id: 21, active: true, ssApiKeyV2: 'ss-key' },
  }),
  {
    ok: false,
    code: 'RATE_SOURCE_UNAVAILABLE',
    error: 'Rate-source client must exist, be active, and have its own ShipStation v2 account.',
  },
);
assert.equal(providerSpyCalls, 0, 'rate-source identity mismatch must not reach the provider spy');

const valid = attemptProviderPurchase({
  selectedRateKey: order101Rate.selectedRateKey,
  purchaseShippingProviderId: 596001,
});
assert.deepEqual(valid, { ok: true });
assert.equal(providerSpyCalls, 1, 'one valid backend-issued proof reaches the provider spy exactly once');

const legacyShipStationBest = normalizeOrderBestRateDto({
  carrier_id: 'se-433542',
  carrier_code: 'stamps_com',
  service_code: 'usps_ground_advantage',
  service_type: 'USPS Ground Advantage',
  shipping_amount: { amount: 5.73, currency: 'USD' },
  other_amount: { amount: 0, currency: 'USD' },
});
assert.equal(legacyShipStationBest?.rateSourceKind, 'shipstation');
assert.equal(legacyShipStationBest?.rateSourceLabel, 'ShipStation');
assert.equal(legacyShipStationBest?.rateSourceDetail, 'Provider #433542');

const appliedDirectBest = normalizeOrderBestRateDto({
  carrierCode: 'ups',
  serviceCode: 'ups_ground',
  shipmentCost: 9.25,
  otherCost: 0,
  shippingProviderId: 10_000_002,
  rateSourceLabel: 'Unknown source',
  raw: {
    directCarrierAccountId: 2,
    provider: 'ups',
    carrier_nickname: 'Warehouse UPS',
  },
});
assert.equal(appliedDirectBest?.rateSourceKind, 'direct');
assert.equal(appliedDirectBest?.rateSourceLabel, 'UPS Direct');
assert.equal(appliedDirectBest?.rateSourceDetail, 'Warehouse UPS');

console.log('PASS PS-433 adversarial rate boundary behavior');
