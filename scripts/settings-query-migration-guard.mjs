import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');

const settings = read('web/src/components/Views/SettingsView.tsx');
const marketplaceFees = read('web/src/components/Views/MarketplaceFeesSection.tsx');
const locations = read('web/src/components/Views/LocationsView.tsx');
const carrierPolicy = read('web/src/components/Settings/CarrierEligibilityPolicyCard.tsx');
const carrierIntegrations = read('web/src/components/Settings/CarrierIntegrationsCard.tsx');
const pendingIntegrations = read('web/src/components/Settings/PendingClientIntegrationsCard.tsx');

assert.match(settings, /import \{ useQuery \} from '@tanstack\/react-query'/);
assert.match(settings, /requestIdleCallback/);
assert.match(settings, /enabled: settingsQueriesReady && activeSection === 'sandbox'/);
assert.match(settings, /enabled: settingsQueriesReady && activeSection === 'system'/);
assert.match(settings, /api\.get<\{ data: SettingsTestClient\[\] \}>\('\/admin\/test-clients'\)/);
assert.match(settings, /api\.get<ObservabilityStatus>\('\/observability\/status'/);
// 2026-09-03: the Settings Automations tab and its legacy controls client are
// retired; AutomationsView owns every /automations/controls read and write.
assert.doesNotMatch(settings, /automation-availability|\/automations\/controls/);
assert.doesNotMatch(settings, /setTestClients|setSystemStatus|setAutomationRows/);

assert.match(marketplaceFees, /queryFn: \(\) => apiClient\.fetchMarketplaceFeeRules\(\)/);
assert.match(marketplaceFees, /\.\.\.activeClientRowsQueryOptions\(\)/);
assert.match(marketplaceFees, /select: clientDtosFromRows/);
assert.match(marketplaceFees, /queryFn: \(\) => apiClient\.fetchStores\(\)/);
assert.doesNotMatch(marketplaceFees, /useEffect/);

assert.match(locations, /queryFn: \(\) => apiClient\.fetchLocations\(\)/);
assert.doesNotMatch(locations, /const loadLocations|setLocations/);

assert.match(carrierPolicy, /queryFn: \(\) => apiClient\.fetchCarrierEligibilityPolicy\(\)/);
assert.doesNotMatch(carrierPolicy, /useEffect/);

assert.match(carrierIntegrations, /queryFn: \(\) => api\.get<\{ data: RawIntegrationRow\[\] \}>\('\/carrier-accounts'\)/);
assert.match(carrierIntegrations, /queryFn: \(\) => api\.get<\{ data: RawIntegrationRow\[\] \}>\('\/store-accounts\?source=admin'\)/);
assert.match(carrierIntegrations, /queryKey: \['settings', 'shipstation-env-accounts'\]/);
assert.match(carrierIntegrations, /queryFn: \(\) => api\.get<\{ data: EnvShipStationAccount\[\] \}>\('\/init\/shipstation-accounts'\)/);
assert.doesNotMatch(carrierIntegrations, /setSaved|useEffect/);

assert.match(pendingIntegrations, /queryFn: \(\) => api\.get<\{ data: PendingIntegration\[\] \}>\('\/carrier-accounts\?source=portal&pending=1'\)/);
assert.match(pendingIntegrations, /queryFn: \(\) => api\.get<\{ data: PendingIntegration\[\] \}>\('\/store-accounts\?source=portal&pending=1'\)/);
assert.doesNotMatch(pendingIntegrations, /setCarrierItems|setStoreItems|useEffect/);

console.log('Settings TanStack Query migration guard passed.');
