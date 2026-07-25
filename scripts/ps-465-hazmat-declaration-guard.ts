import assert from 'node:assert/strict';
import {
  hazmatSemanticHash,
  normalizeAndValidateHazmatDeclaration,
  normalizeHazmatDeclaration,
  quoteHazmatDeclaration,
  sealHazmatDeclaration,
  stableHazmatJson,
} from '../src/services/shipping-workflow/hazmat-declaration.js';
import { buildSsLabelRequestBody } from '../src/lib/shipstation/label-request-body.js';
import { applyShipStationHazmatToShipment } from '../src/lib/shipstation/hazmat.js';
import { buildShipStationForwardLabelOperationRequest } from '../src/services/shipstation-forward-label-operation.js';
import { buildShippingRateRequestFingerprint } from '../src/services/shipping-workflow/rate-fingerprint.js';
import {
  assertShippingQuoteContextMatches,
  shippingQuoteSnapshotIdentityKey,
  type ShippingQuoteAuthorizationContext,
} from '../src/services/shipping-workflow/shipping-quote-authorization.js';

const clear = normalizeHazmatDeclaration({
  status: 'clear',
  dryIce: true,
  dryIceWeightValue: 5,
  materials: [{ unNaNumber: 'UN1845' }],
});
assert.deepEqual(clear, {
  schemaVersion: 1,
  status: 'clear',
  limitedQuantity: false,
  containsBattery: false,
  dryIce: false,
  dryIceWeightValue: null,
  dryIceWeightUnit: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  uspsCategory: null,
  uspsPackageLevel: null,
  regulatedContentType: null,
  materials: [],
}, 'clear declarations must erase active/provider facts');

const dryIceInput = {
  status: 'active',
  dryIce: true,
  dryIceWeightValue: 2.5,
  dryIceWeightUnit: ' Pound ',
  emergencyContactName: '  Dispatch   Desk ',
  emergencyContactPhone: '+1 (206) 555-0100',
  uspsCategory: ' dry_ice ',
  uspsPackageLevel: true,
  regulatedContentType: ' dry_ice ',
};
const dryIce = normalizeAndValidateHazmatDeclaration(dryIceInput);
assert.equal(dryIce.validation.valid, true);
assert.equal(dryIce.declaration.dryIceWeightUnit, 'pound');
assert.equal(dryIce.declaration.emergencyContactName, 'Dispatch Desk');

const missingDryIceWeight = normalizeAndValidateHazmatDeclaration({
  status: 'active',
  dryIce: true,
});
assert.equal(missingDryIceWeight.validation.valid, false);
assert.deepEqual(
  missingDryIceWeight.validation.issues.map((issue) => issue.code),
  ['HAZMAT_DRY_ICE_WEIGHT_REQUIRED', 'HAZMAT_DRY_ICE_UNIT_REQUIRED'],
);

const material = normalizeAndValidateHazmatDeclaration({
  status: 'active',
  materials: [{
    unNaNumber: ' un 1993 ',
    properShippingName: 'Flammable liquids, n.o.s.',
    hazardClass: '3',
    packingGroup: 'II',
    amount: '1.25000',
    amountUnit: 'liter',
    quantity: 1,
    transportMean: 'ground',
    regulationLevel: 'fully_regulated',
  }],
});
assert.equal(material.validation.valid, true);
assert.equal(material.declaration.materials[0]?.unNaNumber, 'UN1993');
assert.equal(material.declaration.materials[0]?.packingGroup, 'ii');

const invalidMaterial = normalizeAndValidateHazmatDeclaration({
  status: 'active',
  materials: [{}],
});
assert.equal(invalidMaterial.validation.valid, false);
assert.ok(invalidMaterial.validation.issues.some((issue) => issue.code === 'HAZMAT_UN_NA_NUMBER_INVALID'));
assert.ok(invalidMaterial.validation.issues.some((issue) => issue.code === 'HAZMAT_REGULATION_LEVEL_REQUIRED'));

assert.equal(
  stableHazmatJson({ beta: 2, alpha: { delta: 4, charlie: 3 } }),
  stableHazmatJson({ alpha: { charlie: 3, delta: 4 }, beta: 2 }),
  'canonical JSON must ignore object-key insertion order',
);
assert.equal(
  hazmatSemanticHash(normalizeHazmatDeclaration(dryIceInput)),
  hazmatSemanticHash(normalizeHazmatDeclaration({ ...dryIceInput })),
  'semantically identical declarations must hash identically',
);

const sealedV1 = sealHazmatDeclaration({
  declaration: dryIce.declaration,
  revision: 1,
  profile: 'shipstation_usps',
});
const sealedV2 = sealHazmatDeclaration({
  declaration: dryIce.declaration,
  revision: 2,
  profile: 'shipstation_usps',
});
const sealedUps = sealHazmatDeclaration({
  declaration: dryIce.declaration,
  revision: 1,
  profile: 'shipstation_ups_dry_ice',
});
assert.notEqual(sealedV1.snapshotHash, sealedV2.snapshotHash, 'revision must be sealed');
assert.notEqual(sealedV1.snapshotHash, sealedUps.snapshotHash, 'provider profile must be sealed');
assert.throws(
  () => sealHazmatDeclaration({ declaration: clear, revision: 1, profile: 'shipstation_usps' }),
  /Only an active hazmat declaration/,
);

const baseLabelInput = {
  carrierId: 'se-123',
  serviceCode: 'usps_ground_advantage',
  packageCode: 'package',
  weightOz: 16,
  length: 10,
  width: 8,
  height: 4,
  shipTo: {
    name: 'Receiver',
    street1: '1 Main St',
    city: 'Seattle',
    state: 'WA',
    postalCode: '98101',
    country: 'US',
    residential: true,
  },
  shipFrom: {
    name: 'Warehouse',
    street1: '100 Depot St',
    city: 'Carson',
    state: 'CA',
    postalCode: '90248',
    country: 'US',
  },
  confirmation: 'none',
  insuranceProvider: 'none',
  insuredValue: null,
  ssOrderId: 77,
  orderNumber: 'ORDER-77',
};
const legacyLabelBody = buildSsLabelRequestBody(baseLabelInput);
assert.deepEqual(legacyLabelBody, {
  shipment: {
    carrier_id: 'se-123',
    service_code: 'usps_ground_advantage',
    ship_date: new Date().toISOString().slice(0, 10),
    ship_from: {
      name: 'Warehouse',
      company_name: undefined,
      phone: '000-000-0000',
      address_line1: '100 Depot St',
      address_line2: undefined,
      city_locality: 'Carson',
      state_province: 'CA',
      postal_code: '90248',
      country_code: 'US',
      address_residential_indicator: 'unknown',
    },
    ship_to: {
      name: 'Receiver',
      company_name: undefined,
      phone: '000-000-0000',
      address_line1: '1 Main St',
      address_line2: undefined,
      city_locality: 'Seattle',
      state_province: 'WA',
      postal_code: '98101',
      country_code: 'US',
      address_residential_indicator: 'yes',
    },
    packages: [{
      weight: { value: 16, unit: 'ounce' },
      package_code: 'package',
      dimensions: { length: 10, width: 8, height: 4, unit: 'inch' },
    }],
    confirmation: 'none',
    external_order_id: 'ORDER-77',
    external_shipment_id: undefined,
  },
  is_return_label: false,
  label_layout: '4x6',
  label_format: 'pdf',
  label_download_type: 'url',
}, 'no-hazmat label body must remain the exact legacy shape');

const untouchedShipment = { packages: [{ package_code: 'package' }] };
assert.strictEqual(
  applyShipStationHazmatToShipment(untouchedShipment, null),
  untouchedShipment,
  'no-hazmat mapper must return the original object',
);

const uspsHazmat = sealHazmatDeclaration({
  declaration: dryIce.declaration,
  revision: 3,
  profile: 'shipstation_usps',
});
const hazmatLabelBody = buildSsLabelRequestBody({ ...baseLabelInput, hazmat: uspsHazmat });
assert.deepEqual(
  (hazmatLabelBody.shipment as Record<string, unknown>).advanced_options,
  { dangerous_goods: true },
);

const upsDryIce = sealHazmatDeclaration({
  declaration: dryIce.declaration,
  revision: 3,
  profile: 'shipstation_ups_dry_ice',
});
assert.deepEqual(
  applyShipStationHazmatToShipment({}, upsDryIce).advanced_options,
  {
    dry_ice: true,
    dry_ice_weight: { value: 2.5, unit: 'pound' },
  },
);
assert.throws(
  () => applyShipStationHazmatToShipment({}, sealHazmatDeclaration({
    declaration: material.declaration,
    revision: 1,
    profile: 'shipstation_ups_dangerous_goods',
  })),
  /not certified/,
);

const legacyFingerprint = buildShippingRateRequestFingerprint({
  version: 'test',
  shipDateBucket: '2026-07-25',
  weightOz: 16,
  toZip: '98101',
  toCountry: 'US',
  residential: true,
  clientId: 7,
  carrierIds: ['se-2', 'se-1'],
});
assert.equal(legacyFingerprint, 'v=test|d=2026-07-25|w=160|z=98101|co=US|r=1|cl=7|c=se-1,se-2');
assert.equal(
  buildShippingRateRequestFingerprint({
    version: 'test',
    shipDateBucket: '2026-07-25',
    weightOz: 16,
    toZip: '98101',
    toCountry: 'US',
    residential: true,
    clientId: 7,
    carrierIds: ['se-2', 'se-1'],
    hazmatSnapshotHash: uspsHazmat.declarationHash,
  }),
  `${legacyFingerprint}|hz=${uspsHazmat.declarationHash}`,
);

const legacyOperation = buildShipStationForwardLabelOperationRequest({
  shippingProviderId: 123,
  carrierCode: 'stamps_com',
  serviceCode: 'usps_ground_advantage',
  packageCode: 'package',
  weightOz: 16,
  dimensions: { length: 10, width: 8, height: 4 },
  packageId: 9,
  shippingOptions: { confirmation: 'none', insuranceProvider: 'none', insuredValue: null },
  shipTo: baseLabelInput.shipTo,
  shipFrom: baseLabelInput.shipFrom,
  orderNumber: 'ORDER-77',
});
assert.equal('hazmatSnapshotHash' in legacyOperation, false);
assert.equal(
  'advanced_options' in ((legacyOperation.providerRequest as any).shipment as Record<string, unknown>),
  false,
);
const hazmatOperation = buildShipStationForwardLabelOperationRequest({
  shippingProviderId: 123,
  carrierCode: 'stamps_com',
  serviceCode: 'usps_ground_advantage',
  packageCode: 'package',
  weightOz: 16,
  dimensions: { length: 10, width: 8, height: 4 },
  packageId: 9,
  shippingOptions: { confirmation: 'none', insuranceProvider: 'none', insuredValue: null },
  shipTo: baseLabelInput.shipTo,
  shipFrom: baseLabelInput.shipFrom,
  orderNumber: 'ORDER-77',
  hazmat: uspsHazmat,
});
assert.equal(hazmatOperation.hazmatSnapshotHash, uspsHazmat.snapshotHash);
assert.equal((hazmatOperation.providerRequest as any).shipment.advanced_options.dangerous_goods, true);

const quoteFacts = quoteHazmatDeclaration({ declaration: dryIce.declaration, revision: 3 });
const quoteContext: ShippingQuoteAuthorizationContext = {
  version: 1,
  order: {
    orderId: 77,
    clientId: 7,
    storeId: null,
    sourceProvider: 'shipstation',
    sourceAccountId: '1',
    sourceOrderId: '77',
  },
  shipment: {
    shipFromLocationId: 1,
    shipFrom: { name: 'Warehouse', company: '', street1: '100 Depot St', street2: '', city: 'Carson', state: 'CA', postalCode: '90248', country: 'US', phone: '' },
    shipTo: { name: 'Receiver', company: '', street1: '1 Main St', street2: '', city: 'Seattle', state: 'WA', postalCode: '98101', country: 'US', phone: '' },
    package: { id: 9, type: 'box', code: 'package' },
    weightOz: 16,
    dimensions: { length: 10, width: 8, height: 4 },
    residential: true,
    confirmation: 'none',
    insuranceProvider: 'none',
    insuredValue: 0,
    hazmat: quoteFacts,
  },
};
assert.doesNotThrow(() => assertShippingQuoteContextMatches({ authorized: quoteContext, current: quoteContext }));
assert.throws(
  () => assertShippingQuoteContextMatches({
    authorized: quoteContext,
    current: {
      ...quoteContext,
      shipment: { ...quoteContext.shipment, hazmat: { ...quoteFacts, revision: 4 } },
    },
  }),
  /hazmat declaration/,
);
const noAuthIdentity = shippingQuoteSnapshotIdentityKey({ rateCacheKey: legacyFingerprint });
assert.equal(noAuthIdentity, legacyFingerprint, 'legacy quote identity must stay byte-identical without authorization');

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SUPABASE_URL ??= 'https://example.invalid';
process.env.SUPABASE_ANON_KEY ??= 'test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
const { resolveHazmatCapabilities } = await import(
  '../src/services/shipping-workflow/hazmat-capability.js'
);
const {
  extractShipStationRates,
  shipStationRateEndpoint,
} = await import('../src/connectors/carrier/shipstation.js');

const allOff = resolveHazmatCapabilities({
  clientId: 7,
  flags: {
    readEnabled: false,
    writeEnabled: false,
    rateEnabled: false,
    purchaseEnabled: false,
    uspsEnabled: false,
    upsShipstationEnabled: false,
    upsDirectEnabled: false,
    walmartEnabled: false,
    canaryClientIds: [],
  },
});
assert.equal(allOff.featureEnabled, false);
assert.equal(allOff.writeEnabled, false);
assert.equal(allOff.profiles.shipstation_usps.ratingSupported, false);
assert.equal(allOff.profiles.shipstation_usps.purchaseSupported, false);

const uspsCanary = resolveHazmatCapabilities({
  clientId: 7,
  flags: {
    readEnabled: true,
    writeEnabled: true,
    rateEnabled: true,
    purchaseEnabled: true,
    uspsEnabled: true,
    upsShipstationEnabled: true,
    upsDirectEnabled: false,
    walmartEnabled: false,
    canaryClientIds: [7],
  },
});
assert.equal(uspsCanary.writeEnabled, true);
assert.equal(uspsCanary.profiles.shipstation_usps.purchaseSupported, true);
assert.equal(uspsCanary.profiles.shipstation_ups_dangerous_goods.purchaseSupported, false);
assert.match(
  uspsCanary.profiles.shipstation_ups_dangerous_goods.unavailableReason ?? '',
  /not certified/i,
);

const excludedClient = resolveHazmatCapabilities({
  clientId: 8,
  flags: {
    readEnabled: true,
    writeEnabled: true,
    rateEnabled: true,
    purchaseEnabled: true,
    uspsEnabled: true,
    upsShipstationEnabled: false,
    upsDirectEnabled: false,
    walmartEnabled: false,
    canaryClientIds: [7],
  },
});
assert.equal(excludedClient.clientAllowed, false);
assert.equal(excludedClient.featureEnabled, false);

const {
  assertHazmatRatingSupported,
  hazmatQuoteFactsForShipping,
  resolveHazmatProfile,
} = await import('../src/services/shipping-workflow/hazmat-shipping-policy.js');
assert.throws(
  () => hazmatQuoteFactsForShipping({
    declaration: dryIce.declaration,
    revision: quoteFacts.revision,
    semanticHash: quoteFacts.declarationHash,
    validation: { valid: true, issues: [] },
    capabilities: allOff,
  }),
  (error: unknown) => (
    error instanceof Error
    && (error as Error & { code?: string }).code === 'HAZMAT_CLIENT_DISABLED'
  ),
  'a persisted declaration must fail closed after the feature kill switch is disabled',
);
assert.equal(resolveHazmatProfile({
  providerFamily: 'shipstation',
  provider: 'shipstation',
  carrierCode: 'stamps_com',
  facts: quoteFacts,
}), 'shipstation_usps');
assert.equal(resolveHazmatProfile({
  providerFamily: 'shipstation',
  provider: 'shipstation',
  carrierCode: 'usps',
  facts: quoteFacts,
}), null, 'USPS from ShipStation must not inherit Stamps.com dangerous-goods support');
assert.equal(resolveHazmatProfile({
  providerFamily: 'shipstation',
  provider: 'shipstation',
  carrierCode: 'ups_walleted',
  facts: quoteFacts,
}), 'shipstation_ups_dry_ice');
const incompleteUspsFacts = quoteHazmatDeclaration({
  declaration: normalizeHazmatDeclaration({ status: 'active', limitedQuantity: true }),
  revision: 1,
});
assert.throws(
  () => assertHazmatRatingSupported({
    facts: incompleteUspsFacts,
    profile: 'shipstation_usps',
    capabilities: uspsCanary,
  }),
  (error: unknown) => (
    error instanceof Error
    && (error as Error & { code?: string }).code === 'HAZMAT_PROFILE_DECLARATION_INVALID'
  ),
);

assert.equal(shipStationRateEndpoint(), '/v2/rates/estimate');
assert.equal(shipStationRateEndpoint('shipment'), '/v2/rates');
assert.deepEqual(extractShipStationRates([{ rate_id: 'legacy' }]), [{ rate_id: 'legacy' }]);
assert.deepEqual(
  extractShipStationRates({ rate_response: { rates: [{ rate_id: 'shipment-rate' }] } }),
  [{ rate_id: 'shipment-rate' }],
);
const { buildShipStationFullRateBody } = await import('../src/services/rates.js');
const fullRateBody = buildShipStationFullRateBody(
  [{ carrier_id: 'se-123', carrier_code: 'stamps_com', nickname: 'USPS' }] as any,
  {
    weightOz: 16,
    toZip: '10001',
    toCountry: 'US',
    toState: 'NY',
    toCity: 'New York',
    toAddress: '1 Test St',
    toName: 'Test Recipient',
    hazmatQuoteFacts: quoteFacts,
    hazmatCapabilities: uspsCanary,
  },
  {
    name: 'Test Sender',
    address_line1: '2 Test Ave',
    city_locality: 'Seattle',
    state_province: 'WA',
    postal_code: '98101',
    country_code: 'US',
  },
);
assert.deepEqual(fullRateBody.rate_options, { carrier_ids: ['se-123'] });
assert.equal(
  ((fullRateBody.shipment as any).advanced_options as Record<string, unknown>).dangerous_goods,
  true,
);
assert.equal((fullRateBody.shipment as any).packages[0].weight.unit, 'ounce');

console.log('PS-465 hazmat declaration/capability guard passed');
