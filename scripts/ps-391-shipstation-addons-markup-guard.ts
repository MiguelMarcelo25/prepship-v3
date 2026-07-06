/**
 * PS-391 guard - ShipStation add-on money participates in markup and ranking.
 *
 * Pure/offline: no DB, no network, no labels, no provider calls. Drives the
 * real backend rate-money owners so Rate Browser and Best Rate cannot treat
 * ShipStation add-ons as side notes outside the customer/ranking total.
 */
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/prepship_guard';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'guard-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'guard-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'guard-jwt-secret';

const { applyMarkups } = await import('../src/services/rates');
const { rateCostTotal, rateTotal } = await import('../src/services/rates-combined');
const { normalizeShippingRateMoney } = await import('../src/services/shipping-workflow/shipping-rate-money-normalizer');

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function shipStationRate(input: {
  carrierId: string;
  shipping: number;
  other?: number;
  insurance?: number;
  confirmation?: number;
}) {
  return {
    carrier_id: input.carrierId,
    carrier_code: 'ups',
    service_code: 'ups_ground',
    service_type: 'UPS Ground',
    shipping_amount: { amount: input.shipping, currency: 'USD' },
    other_amount: { amount: input.other ?? 0, currency: 'USD' },
    insurance_amount: { amount: input.insurance ?? 0, currency: 'USD' },
    confirmation_amount: { amount: input.confirmation ?? 0, currency: 'USD' },
  } as any;
}

const percent15 = new Map<string, any>([['se-orion', { type: 'percent', value: 15 }]]);

const [orion] = applyMarkups([
  shipStationRate({ carrierId: 'se-orion', shipping: 8.39, other: 4.59, insurance: 0 }),
], percent15 as any);

assert.equal(
  rateCostTotal(orion),
  12.98,
  'ORION selected/internal cost must include shipping_amount + other_amount before markup',
);
assert.equal(
  rateTotal(orion),
  14.93,
  'ORION customer/ranking amount must apply markup after provider all-in add-ons',
);
assert.equal(
  normalizeShippingRateMoney(orion).shippingMarginAmount,
  money(14.93 - 12.98),
  'ORION margin must compare customer all-in against selected/internal all-in',
);

const noMarkupOrion = shipStationRate({ carrierId: 'se-orion', shipping: 8.39, other: 4.59, insurance: 0 });
assert.equal(
  rateTotal(noMarkupOrion),
  12.98,
  'without markup, customer/ranking amount equals provider all-in subtotal',
);
assert.equal(
  rateCostTotal(noMarkupOrion),
  12.98,
  'without markup, internal cost equals provider all-in subtotal',
);

const usps = shipStationRate({ carrierId: 'se-usps', shipping: 7.95, insurance: 1.09, other: 0 });
assert.equal(
  rateTotal(usps),
  9.04,
  'USPS insurance fixture must remain 7.95 + 1.09, with no double-count',
);
assert.equal(
  rateCostTotal(usps),
  9.04,
  'USPS selected/internal cost must remain the same all-in amount',
);

const [direct] = applyMarkups([
  {
    carrier_id: 'se-direct',
    carrier_code: 'ups',
    service_code: 'ups_ground',
    shipping_amount: { amount: 5, currency: 'USD' },
    other_amount: { amount: 0, currency: 'USD' },
    cShippingRateAmount: 5,
    selectedRateCost: 5,
  } as any,
], new Map<string, any>([['se-direct', { type: 'amount', value: 2 }]]) as any);

assert.equal(rateCostTotal(direct), 5, 'direct-carrier selected/internal cost must not be marked up');
assert.equal(rateTotal(direct), 7, 'direct-carrier customer amount must still use configured markup');

console.log('PASS PS-391 ShipStation add-on markup/ranking guard');
