/**
 * PS-328 - stale re-rate warning reason guard.
 *
 * The order row package-facts read model owns the display-safe warning reason for
 * a saved rate that cannot be purchased as-is. The frontend may render that
 * backend verdict, but it must not collapse every stale/expired rate into the
 * misleading "package changed" copy.
 *
 * Pure/offline: no DB, no providers, no labels, no shipped/cancelled mutation.
 */
import { readFileSync } from 'node:fs';
import { buildOrderRowPackageFacts, type BuildOrderRowPackageFactsInput } from '../src/services/shipping-workflow/order-row-package-facts';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const DIMS = { length: 4, width: 6, height: 3 };

function facts(overrides: Partial<BuildOrderRowPackageFactsInput>) {
  return buildOrderRowPackageFacts({
    orderStatus: 'awaiting_shipment',
    externallyShipped: false,
    canonicalStatus: 'awaiting_shipment',
    hasActiveLabel: false,
    packageState: 'resolved',
    rateState: 'final',
    requiresRerate: false,
    weightOz: 11,
    dims: DIMS,
    selectedPackageId: '493',
    ...overrides,
  });
}

const finalRate = facts({ rateState: 'final', requiresRerate: false });
check('matching/final rate facts do not create a warning reason',
  finalRate.staleRateImpact === false &&
  finalRate.requiresRerate === false &&
  finalRate.rerateReason === null &&
  finalRate.rerateCopy === null,
  finalRate);

const expiredRate = facts({ rateState: 'expired', requiresRerate: true });
check('expired current-matching rate still blocks purchase',
  expiredRate.staleRateImpact === true && expiredRate.requiresRerate === true,
  expiredRate);
check('expired current-matching rate warns as expired, not package changed',
  expiredRate.rerateReason === 'rate_expired' &&
  expiredRate.rerateCopy === 'Re-rate needed - saved rate expired' &&
  !/package changed/i.test(String(expiredRate.rerateCopy)),
  expiredRate);

const staleRate = facts({ rateState: 'stale', requiresRerate: true });
check('mismatched/stale rate still blocks purchase',
  staleRate.staleRateImpact === true && staleRate.requiresRerate === true,
  staleRate);
check('mismatched/stale rate exposes backend-owned mismatch copy',
  staleRate.rerateReason === 'rate_changed' &&
  staleRate.rerateCopy === 'Re-rate needed - saved rate out of date',
  staleRate);

const shippedRate = facts({ orderStatus: 'shipped', rateState: 'stale', requiresRerate: true });
check('shipped row suppresses stale impact and warning reason',
  shippedRate.staleRateImpact === false &&
  shippedRate.requiresRerate === false &&
  shippedRate.rerateReason === null &&
  shippedRate.rerateCopy === null,
  shippedRate);

const panelFields = read('web/src/components/Views/OrdersPanelShippingFields.tsx');
check('frontend reads backend rerateCopy instead of hardcoding package-changed copy',
  /packageFacts\.rerateCopy/.test(panelFields) &&
  !/package changed/i.test(panelFields));
check('frontend still keys warning on staleRateImpact only',
  /if \(packageFacts\.staleRateImpact\) \{/.test(panelFields) &&
  !/packageFacts\.staleRateImpact \|\| packageFacts\.requiresRerate/.test(panelFields));

const ordersView = read('web/src/components/Views/OrdersView.tsx');
const persistStart = ordersView.indexOf('async function persistAppliedRateForOrder(');
const persistEnd = ordersView.indexOf('\n  useEffect(() => {', persistStart);
const persistBlock = persistStart >= 0 && persistEnd > persistStart
  ? ordersView.slice(persistStart, persistEnd)
  : '';
check('Apply/Recalculate refetch invalidates selected order detail packageFacts',
  /if \(options\.refetch\) \{[\s\S]{0,600}await refetchOrders\(\)[\s\S]{0,600}queryClient\.invalidateQueries\(\{ queryKey: \['v2-hooks:order-detail', orderId\] \}\)/.test(persistBlock));

const refreshPanelStart = ordersView.indexOf('async function refreshPanelBestRate(');
const refreshPanelEnd = ordersView.indexOf('\n  function applyRateSelection(', refreshPanelStart);
const refreshPanelBlock = refreshPanelStart >= 0 && refreshPanelEnd > refreshPanelStart
  ? ordersView.slice(refreshPanelStart, refreshPanelEnd)
  : '';
check('panel Recalculate test-rate persist refreshes selected order detail packageFacts',
  /persistAppliedRateForOrder\(order\.orderId, testRate,[\s\S]{0,500}refetch: true/.test(refreshPanelBlock));
check('panel Recalculate live-rate persist refreshes selected order detail packageFacts',
  /persistAppliedRateForOrder\(order\.orderId, bestRateWithMetadata,[\s\S]{0,700}refetch: true/.test(refreshPanelBlock));

if (failures > 0) {
  console.error(`\nPS-328 rerate warning reason guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-328 rerate warning reason guard passed.');
