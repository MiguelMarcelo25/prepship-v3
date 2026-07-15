/**
 * Audit 2026-07-13 item 4.1 dead-code and frontend rate-authority guard.
 *
 * Offline only: source inspection plus pure DTO mapping. No configured DB,
 * provider, label/postage, marketplace, inventory, or production data access.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildRateRows } from '../web/src/components/Views/rates-parity';

const backendBest = {
  selectedRateKey: 'backend-selected',
  selectedRateCost: 8,
  cShippingRateAmount: 12,
  shippingMarginAmount: 4,
  carrierCode: 'ups',
  serviceCode: 'ups_ground',
  serviceName: 'UPS Ground',
} as any;
const clientCheaper = {
  selectedRateKey: 'not-selected',
  selectedRateCost: 5,
  cShippingRateAmount: 6,
  shippingMarginAmount: 1,
  carrierCode: 'usps',
  serviceCode: 'usps_ground_advantage',
  serviceName: 'USPS Ground Advantage',
} as any;

const rows = buildRateRows([backendBest, clientCheaper], backendBest);
assert.deepEqual(
  {
    baseCost: rows[0]?.baseCost,
    yourPrice: rows[0]?.yourPrice,
    profit: rows[0]?.profit,
  },
  { baseCost: 8, yourPrice: 12, profit: 4 },
  'Rates display must consume the backend money tuple verbatim',
);
assert.equal(rows[0]?.isBest, true, 'backend-selected identity must own the CHEAPEST badge');
assert.equal(
  rows[1]?.isBest,
  false,
  'a locally cheaper row must not replace the backend-selected best rate',
);

const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
const ratesView = readFileSync('web/src/components/Views/RatesView.tsx', 'utf8');
const ratesParity = readFileSync('web/src/components/Views/rates-parity.ts', 'utf8');
const markupsContext = readFileSync('web/src/contexts/MarkupsContext.tsx', 'utf8');
const hooksIndex = readFileSync('web/src/hooks/index.ts', 'utf8');
const ps178 = readFileSync('scripts/ps-178-fe-authority-ratchet-guard.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const guardPack = readFileSync('scripts/sot-guard-pack.mjs', 'utf8');

assert.equal(existsSync('web/src/hooks/useSyncPoller.ts'), false, 'orphan sync poller must stay deleted');
assert.doesNotMatch(hooksIndex, /useSyncPoller/, 'hook barrel must not retain an orphan tombstone');
assert.doesNotMatch(
  backfill,
  /\b(?:ServiceTier|classifyTier|pickBestForTier)\b/,
  'unused service-tier selector cluster must stay deleted',
);
assert.match(ratesView, /apiClient\.browseRates\(/, 'Rates view must consume the backend browse DTO');
assert.match(ratesView, /bestRate: response\?\.bestRate \?\? null/, 'Rates view must retain backend bestRate');
assert.doesNotMatch(ratesView, /useMarkups/, 'Rates view must not read markup settings');
assert.match(
  ratesParity,
  /selectedRateCost[\s\S]*cShippingRateAmount[\s\S]*shippingMarginAmount/,
  'Rates rows must render backend money aliases',
);
assert.match(
  ratesParity,
  /backendBestIdentity[\s\S]*backendRateIdentity\(rate\) === backendBestIdentity/,
  'Rates rows must identify best from the backend-selected key',
);
assert.doesNotMatch(
  ratesParity,
  /\b(?:RateMarkupsMap|getRateMarkup|getMarkupAmount|providerIdFromCarrierId)\b/,
  'frontend markup lookup and math must stay deleted',
);
assert.doesNotMatch(
  markupsContext,
  /\b(?:applyMarkup|clearRateCache)\b/,
  'markup context must expose settings state/actions only',
);
assert.equal(existsSync('web/src/utils/markups.ts'), false, 'frontend markup/eligibility authority must stay deleted');
assert.match(ps178, /const allowlist: string\[\] = \[\]/, 'FE money-authority allowlist must be empty');
assert.ok(packageJson.includes('"test:audit-dead-code-cleanup"'), 'package must expose the 4.1 guard');
assert.ok(guardPack.includes("'test:audit-dead-code-cleanup'"), 'SOT pack must require the 4.1 guard');

console.log('PASS Audit 4.1 dead-code and frontend rate-authority guard');
