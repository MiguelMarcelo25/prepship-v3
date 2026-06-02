import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  HUGRAB_GROUND_SAVER_BLOCK_REASON,
  evaluateShippingServiceEligibility,
  filterCarrierAccountsForAutomation,
  filterEligibleShippingServices,
  type ShippingAutomationRule,
} from '../src/lib/shipping-service-eligibility';
import { rateCacheKey } from '../src/services/rates';

const rules: ShippingAutomationRule[] = [
  {
    type: 'carrier',
    clientId: 9,
    storeId: 363392,
    carrierId: 'se-disabled',
    disabled: true,
    reason: 'Disabled by Automation',
  },
  {
    type: 'service',
    clientId: 9,
    serviceCode: 'ups_next_day_air',
    disabled: true,
    reason: 'Service disabled by Automation',
  },
];

const visibleCarriers = filterCarrierAccountsForAutomation(
  [
    { carrier_id: 'se-enabled', nickname: 'Enabled UPS' },
    { carrier_id: 'se-disabled', nickname: 'Disabled UPS' },
  ],
  { clientId: 9, storeId: 363392 },
  rules,
  (carrier) => ({
    carrierId: carrier.carrier_id,
    carrierName: carrier.nickname,
  }),
);

assert.deepEqual(
  visibleCarriers.map((carrier) => carrier.carrier_id),
  ['se-enabled'],
  'Automation carrier rules must hide disabled carrier accounts from rate surfaces',
);

assert.match(
  rateCacheKey({
    weightOz: 16,
    toZip: '90248',
    carrierIds: [],
    automationRulesVersion: 'test',
  }),
  /\|c=\|/,
  'An empty allowed carrier set must be preserved in the rate fingerprint',
);

const serviceEligibility = evaluateShippingServiceEligibility(
  { clientId: 9, storeId: 363392 },
  { carrierId: 'se-enabled', serviceCode: 'ups_next_day_air', serviceName: 'UPS Next Day Air' },
  null,
  rules,
);

assert.equal(serviceEligibility.allowed, false, 'Automation service rules must block configured services');
assert.equal(serviceEligibility.reason, 'Service disabled by Automation');

const filteredServices = filterEligibleShippingServices(
  [
    { service_code: 'ups_ground', service_type: 'UPS Ground' },
    { service_code: 'ups_next_day_air', service_type: 'UPS Next Day Air' },
  ],
  { clientId: 9, storeId: 363392 },
  (service) => ({
    serviceCode: service.service_code,
    serviceName: service.service_type,
  }),
  null,
  rules,
);

assert.deepEqual(
  filteredServices.map((service) => service.service_code),
  ['ups_ground'],
  'Automation service rules must filter disabled services from best-rate candidates',
);

const hugrabGroundSaver = evaluateShippingServiceEligibility(
  { clientId: 4, clientName: 'HUGRAB', storeId: 378060 },
  { serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver' },
  null,
  [
    {
      type: 'service',
      clientId: 4,
      serviceCode: 'ups_ground_saver',
      disabled: false,
      reason: 'Attempted unlock',
    },
  ],
);

assert.equal(hugrabGroundSaver.allowed, false, 'HUGRAB Ground Saver must remain locked disabled');
assert.equal(hugrabGroundSaver.reason, HUGRAB_GROUND_SAVER_BLOCK_REASON);

const routeSource = readFileSync('src/routes/automation.ts', 'utf8');
assert.match(routeSource, /requireInternalPermission\('settings:read'\)/, 'Automation reads must require internal settings read');
assert.match(routeSource, /requireInternalPermission\('settings:write'\)/, 'Automation writes must require internal settings write');
assert.match(routeSource, /SHIPPING_AUTOMATION_RULES_KEY/, 'Automation route must expose the settings-backed rules key');

const automationServiceSource = readFileSync('src/services/shipping-automation.ts', 'utf8');
assert.match(automationServiceSource, /shipping_automation_rules/, 'Automation rules must persist in the settings table');
assert.match(automationServiceSource, /upsertShippingAutomationRule/, 'Automation rules must support per-rule upserts');

const mainSource = readFileSync('src/main.ts', 'utf8');
assert.match(mainSource, /app\.route\('\/automation'/, 'Automation route must be mounted');

const settingsSource = readFileSync('web/src/components/Views/SettingsView.tsx', 'utf8');
assert.match(settingsSource, /\/automation\/availability/, 'Settings Automation must load the normalized Automation API');
assert.match(settingsSource, /toggleAutomationCarrier/, 'Settings Automation must expose carrier account controls');
assert.match(settingsSource, /toggleAutomationService/, 'Settings Automation must expose service controls');
assert.match(settingsSource, /PS-057 locked/, 'HUGRAB locked rule must be visible in the Automation UI');

console.log('PS Automation controls guard passed');
