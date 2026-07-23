/**
 * PS-433 frontend source-of-truth sweep guard.
 *
 * Offline only: pure behavior checks plus source inspection. This script does
 * not connect to a database or provider, buy postage, create a label, notify a
 * marketplace, or mutate production shipped/cancelled data.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateClientRateSourcePolicy } from '../src/services/client-rate-source-policy.js';
import {
  resolveBillingPresetWindow,
  resolveDashboardReportingWindow,
  resolveReportingPickerPreset,
} from '../src/services/reporting-window-presets.js';
import { stampRateSourceDisplay } from '../src/services/rate-source-display.js';
import { finalizeAppliedBestRateFromSnapshot } from '../src/services/shipping-workflow/apply-best-rate.js';

const read = (path: string): string => readFileSync(path, 'utf8');

const ratesParity = read('web/src/components/Views/rates-parity.ts');
const ratesView = read('web/src/components/Views/RatesView.tsx');
const rateBrowser = read('web/src/components/RateBrowserModal.tsx');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const invoice = read('web/src/pages/Invoice.tsx');
const sharedClient = read('web/src/lib/v2-apiClient/shared.ts');
const apiClientSource = read('web/src/lib/v2-apiClient.ts');
const datePicker = read('web/src/components/DateRangePicker.tsx');
const rangeToggle = read('web/src/components/RangeToggle.tsx');
const analysisParity = read('web/src/components/Views/analysis-parity.ts');
const billingParity = read('web/src/components/Views/billing-parity.ts');
const dashboard = read('web/src/components/Views/DashboardView.tsx');
const rateBrowseProducer = read('src/services/rate-browse-response-producer.ts');
const clientRoutes = `${read('src/routes/clients.ts')}\n${read('src/routes/admin.ts')}`;
const analysisRoute = read('src/routes/analysis.ts');
const billingRoute = read('src/routes/billing.ts');
const shipStationCredentials = read('src/lib/shipstation/credentials.ts');
const confirmedScope = JSON.parse(read('docs/ps-tickets/PS-433/sot-confirmed.json')) as {
  taskId: string;
  source: { implementationSha: string };
  findings: Array<{
    id: string;
    severity: 'high' | 'medium';
    rule: string;
    unsafeOwner: string;
    canonicalOwner: string;
    entryPoint: string;
    disposition: string;
    callers: string;
    proof: string;
  }>;
};

assert.equal(confirmedScope.taskId, 'PS-433');
assert.equal(confirmedScope.source.implementationSha, '49b913fc35b4564571d9bd0f1ce814714a17b0fc');
assert.equal(confirmedScope.findings.length, 42, 'the repository must carry all 42 reverified findings');
assert.equal(new Set(confirmedScope.findings.map((finding) => finding.id)).size, 42);
assert.equal(confirmedScope.findings.filter((finding) => finding.severity === 'high').length, 15);
assert.equal(confirmedScope.findings.filter((finding) => finding.severity === 'medium').length, 27);
assert.ok(confirmedScope.findings.every((finding) =>
  finding.rule.trim() &&
  finding.unsafeOwner.trim() &&
  finding.canonicalOwner.trim() &&
  finding.entryPoint.trim() &&
  finding.disposition.trim() &&
  finding.callers.trim() &&
  finding.proof.startsWith('npm run '),
));

// Rate list money, official best identity, source labels, and availability are
// backend DTO facts. UI filtering may express operator display intent only.
assert.doesNotMatch(ratesParity, /isBlockedRate|getAvailableRates|DIRECT_PROVIDER_LABELS/);
assert.match(ratesParity, /selectedRateCost/);
assert.match(ratesParity, /cShippingRateAmount/);
assert.match(ratesParity, /backendBestIdentity/);
assert.match(ratesParity, /rateSourceLabel/);
assert.doesNotMatch(ratesView, /getAvailableRates/);
assert.match(rateBrowser, /rateBrowserUnavailableReason/);
assert.doesNotMatch(rateBrowser, /function isBlockedRate|TEST_MOCK_SERVICE_TEMPLATES|buildTestMockRateSeeds/);
assert.match(rateBrowseProducer, /getCarrierAccountsForRateContext/);
assert.match(rateBrowseProducer, /stampRateSourceDisplayList/);
assert.match(sharedClient, /rateSourceLabel: obj\.rateSourceLabel/);

// Test-mode rates and Apply persistence use the same backend rate/quote owners.
assert.doesNotMatch(ordersView, /buildTestMockRate|buildBestTestRateForShipment|buildTestRateBrowserAccounts/);
const persistStart = ordersView.indexOf('async function persistAppliedRateForOrder');
const persistEnd = ordersView.indexOf('async function refreshPanelBestRate', persistStart);
assert.ok(persistStart >= 0 && persistEnd > persistStart);
const persistAppliedRate = ordersView.slice(persistStart, persistEnd);
assert.match(persistAppliedRate, /apiClient\.applyBestRate/);
assert.doesNotMatch(persistAppliedRate, /saveOrderBestRate|saveOrderDims|saveOrderSelectedPid/);
assert.match(ordersView, /Per user override unlock shipped data on 2026-07-15: PS-433/);
assert.deepEqual(
  finalizeAppliedBestRateFromSnapshot({ rateQuoteId: null, selectedRateKey: null, snapshot: null }),
  {
    ok: false,
    code: 'rate_quote_required',
    error: 'Backend rate-quote proof is required. Re-rate before applying this rate.',
  },
);

// Billing invoice totals are returned by the canonical backend owner and
// rendered verbatim; fail-closed reads reject before stale-cache recovery.
assert.match(billingRoute, /billingInvoiceHeaderTotals/);
assert.match(billingRoute, /return c\.json\(\{ data: rows, totals \}\)/);
assert.match(invoice, /totals\.pickPackTotal/);
assert.match(invoice, /totals\?\.grandTotal/);
assert.doesNotMatch(invoice, /\.reduce\([\s\S]{0,240}totalCost/);
assert.doesNotMatch(
  `${sharedClient}\n${apiClientSource}`,
  /\bcachedSafe\b/,
  'the retired stale-cache fallback must not return for money reads',
);
const billingSummaryStart = apiClientSource.indexOf('fetchBillingSummary(');
const billingSummaryEnd = apiClientSource.indexOf('fetchShippingMarginAnalytics(', billingSummaryStart);
assert.ok(billingSummaryStart >= 0 && billingSummaryEnd > billingSummaryStart);
const billingSummary = apiClientSource.slice(billingSummaryStart, billingSummaryEnd);
assert.match(billingSummary, /const \[res, clientsRes\] = await Promise\.all\(\[\s*api\.get/);
assert.doesNotMatch(billingSummary, /\bsafe\s*\(/);

// Client rate-source writes and reporting windows have explicit backend owners.
assert.equal(evaluateClientRateSourcePolicy({ clientId: 4, rateSourceClientId: 4, source: null }).ok, false);
assert.equal(
  evaluateClientRateSourcePolicy({
    clientId: 4,
    rateSourceClientId: 7,
    source: { id: 7, active: true, ssApiKeyV2: 'ss-key' },
  }).ok,
  true,
);
assert.match(clientRoutes, /validateClientRateSourceWrite/);
assert.match(shipStationCredentials, /evaluateClientRateSourcePolicy/);
assert.doesNotMatch(shipStationCredentials, /rate-source lookup failed[\s\S]*console\.warn/);

const now = new Date('2026-07-01T08:05:00.000Z');
assert.deepEqual(resolveBillingPresetWindow('last_month', now), { from: '2026-06-01', to: '2026-06-30' });
assert.deepEqual(resolveReportingPickerPreset('last7', now), { from: '2026-06-25', to: '2026-07-01' });
assert.deepEqual(resolveDashboardReportingWindow({ from: '2026-06-02', to: '2026-07-01' }), {
  current: { from: '2026-06-02', to: '2026-07-01' },
  prior: { from: '2026-05-03', to: '2026-06-01' },
  currentTrailingSeven: { from: '2026-06-25', to: '2026-07-01' },
  priorTrailingSeven: { from: '2026-05-26', to: '2026-06-01' },
  rangeDays: 30,
});
assert.match(analysisRoute, /resolveDashboardReportingWindow/);
assert.match(billingRoute, /resolveBillingPresetWindow/);
assert.doesNotMatch(`${datePicker}\n${analysisParity}\n${billingParity}\n${dashboard}`, /priorRange|defaultLast30|dateOffsetFrom/);
assert.match(rangeToggle, /\/analysis\/preset-window/);

assert.deepEqual(
  stampRateSourceDisplay({ directCarrierAccountId: 2, provider: 'ups', carrier_nickname: 'Warehouse UPS' }),
  {
    directCarrierAccountId: 2,
    provider: 'ups',
    carrier_nickname: 'Warehouse UPS',
    rateSourceKind: 'direct',
    rateSourceLabel: 'UPS Direct',
    rateSourceDetail: 'Warehouse UPS',
  },
);
assert.equal(
  stampRateSourceDisplay(
    { carrier_id: 'se-123' },
    [{ carrier_id: 'se-123', source_client_id: 7, source_client_name: 'Rate Owner' }],
  ).rateSourceDetail,
  'Rate Owner | Client #7 | Provider #123',
);

console.log('PS-433 frontend source-of-truth sweep guard passed.');
