import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  HUGRAB_GROUND_SAVER_BLOCK_REASON,
  evaluateShippingServiceEligibility,
  findDisabledCarrierAutomationRule,
  filterCarrierAccountsForAutomation,
  filterEligibleShippingServices,
  isHugrabCarrierDisableProtected,
  type ShippingAutomationRule,
} from '../src/lib/shipping-service-eligibility';

process.env.DATABASE_URL ??= 'postgres://postgres:postgres@127.0.0.1:5432/prepship_test';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-test';

const { rateCacheKey } = await import('../src/services/rates');
const {
  shippingAutomationControlKey,
  shippingAutomationControlsFingerprint,
} = await import('../src/services/automations/shipping-controls');

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

assert.equal(
  shippingAutomationControlKey({ ...rules[0]!, carrierId: ' SE-DISABLED ' }),
  shippingAutomationControlKey(rules[0]!),
  'typed control identity normalizes operator whitespace and case',
);
assert.equal(
  shippingAutomationControlsFingerprint(rules),
  shippingAutomationControlsFingerprint(rules),
  'typed control fingerprints are deterministic',
);
assert.notEqual(
  shippingAutomationControlsFingerprint(rules),
  shippingAutomationControlsFingerprint([{ ...rules[0]!, reason: 'Changed policy' }, rules[1]!]),
  'control changes continue to invalidate the rate/cache fingerprint',
);

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

assert.equal(
  findDisabledCarrierAutomationRule(
    { clientId: 9, storeId: 363392 },
    { carrierId: 'se-other', carrierCode: null },
    rules,
  ),
  null,
  'missing carrier codes never collide when carrier IDs differ',
);

const hugrabVisibleCarriers = filterCarrierAccountsForAutomation(
  [
    { carrier_id: 'se-hugrab-ups', carrier_code: 'ups', nickname: 'HUGRAB UPS' },
  ],
  { clientId: 4, clientName: 'HUGRAB', storeId: 378060 },
  [
    {
      type: 'carrier',
      clientId: 4,
      storeId: 378060,
      carrierId: 'se-hugrab-ups',
      carrierCode: 'ups',
      disabled: true,
      reason: 'Accidental carrier disable',
    },
  ],
  (carrier) => ({
    carrierId: carrier.carrier_id,
    carrierCode: carrier.carrier_code,
    carrierName: carrier.nickname,
  }),
);

assert.deepEqual(
  hugrabVisibleCarriers.map((carrier) => carrier.carrier_id),
  ['se-hugrab-ups'],
  'PS-057 must not allow Automation carrier-level disables to hide HUGRAB UPS Ground-capable accounts',
);

assert.equal(
  isHugrabCarrierDisableProtected(
    { clientId: 4, clientName: 'HUGRAB', storeId: 378060 },
    { carrierCode: 'ups', carrierName: 'HUGRAB UPS' },
  ),
  true,
  'HUGRAB UPS carriers must be protected from accidental carrier-level disable',
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

const routeSource = readFileSync('src/routes/automations.ts', 'utf8');
assert.match(routeSource, /app\.get\('\/controls', requireInternalPermission\('automations:read'\)/, 'Control reads use Automations RBAC');
assert.match(routeSource, /app\.patch\('\/controls\/carrier', requireInternalPermission\('automations:write'\)/, 'Control writes use Automations RBAC');
assert.match(routeSource, /setCarrierShippingControl/, 'The route delegates carrier policy to the backend workflow owner');
assert.match(routeSource, /setServiceShippingControl/, 'The route delegates service policy to the backend workflow owner');
assert.match(routeSource, /assertResourceInScope\(scope\(c as never\), body/, 'Control writes enforce client/store scope before delegation');

const automationServiceSource = readFileSync('src/services/automations/shipping-controls.ts', 'utf8');
assert.match(automationServiceSource, /automationShippingControls/, 'Controls persist in the typed relational table');
assert.match(automationServiceSource, /upsertShippingAutomationControls/, 'Typed controls support atomic batch upserts');
assert.doesNotMatch(automationServiceSource, /settings|shipping_automation_rules/, 'The canonical owner has no settings fallback');

const workflowSource = readFileSync('src/services/automations/shipping-controls-workflow.ts', 'utf8');
assert.match(workflowSource, /PS-057 locks services, not whole UPS carrier accounts/, 'The backend workflow rejects HUGRAB UPS carrier-level disable');
assert.match(workflowSource, /upsertShippingAutomationControls\(changes\)/, 'Store-wide changes persist atomically through the typed owner');
assert.match(workflowSource, /findDisabledCarrierAutomationRule/, 'Availability delegates carrier matching to the canonical eligibility policy');
assert.match(workflowSource, /filterClientsForScope\(clientRows, scope\)/, 'Control availability is filtered by the caller scope');
assert.match(workflowSource, /controls\.filter\(\(control\) => isResourceInScope\(scope/, 'Raw controls are filtered by the caller scope before returning');

const mainSource = readFileSync('src/main.ts', 'utf8');
assert.doesNotMatch(mainSource, /app\.route\('\/automation'/, 'The legacy singular route is retired');
assert.match(mainSource, /app\.route\('\/automations'/, 'The versioned Automations route remains mounted');

const settingsSource = readFileSync('web/src/components/Views/SettingsView.tsx', 'utf8');
assert.match(settingsSource, /\/automations\/controls/, 'Settings compatibility code delegates to the typed Automations API');
assert.match(settingsSource, /toggleAutomationCarrier/, 'Settings Automation must expose carrier account controls');
assert.match(settingsSource, /toggleAutomationService/, 'Settings Automation must expose service controls');

const automationsView = readFileSync('web/src/components/Views/AutomationsView.tsx', 'utf8');
assert.match(automationsView, /\/automations\/controls\/carrier/, 'The Operations Console writes through the typed carrier endpoint');
assert.match(automationsView, /\/automations\/controls\/service/, 'The Operations Console writes through the typed service endpoint');
assert.match(automationsView, /disabled=\{service\.locked \|\| busy != null\}/, 'HUGRAB locked controls remain visibly non-interactive');
assert.doesNotMatch(automationsView, /["']\/automation\//, 'The Operations Console has no singular-route fallback');

for (const [path, source] of [
  ['src/main.ts', mainSource],
  ['src/services/automations/shipping-controls.ts', automationServiceSource],
  ['src/services/automations/shipping-controls-workflow.ts', workflowSource],
  ['web/src/components/Views/AutomationsView.tsx', automationsView],
] as const) {
  assert.doesNotMatch(source, /shipping_automation_rules/, `${path} cannot reintroduce the retired settings authority`);
}

function runtimeFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? runtimeFiles(path) : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

const runtimeSources = runtimeFiles('src').concat(runtimeFiles('web/src'))
  .map((path) => `${path}\n${readFileSync(path, 'utf8')}`)
  .join('\n');
assert.doesNotMatch(runtimeSources, /shipping_automation_rules/, 'Runtime code cannot reintroduce the retired settings key');
assert.doesNotMatch(runtimeSources, /services\/shipping-automation/, 'Runtime code cannot reintroduce the deleted settings service');
assert.doesNotMatch(runtimeSources, /app\.route\('\/automation'/, 'Runtime code cannot remount the retired singular API');
assert.doesNotMatch(runtimeSources, /["']\/automation\//, 'Runtime callers cannot use the retired singular API');

console.log('PS Automation controls guard passed');
