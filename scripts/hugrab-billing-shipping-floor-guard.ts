import { existsSync, readFileSync } from 'node:fs';

const script = readFileSync('scripts/hugrab-billing-shipping-floor.ts', 'utf8');
const servicePath = 'src/services/hugrab-billing-shipping-floor.ts';
const routePath = 'src/routes/billing.ts';
const apiClientPath = 'web/src/lib/v2-apiClient.ts';
const modalPath = 'web/src/components/Views/HugrabShippingFloorModal.tsx';
const billingViewPath = 'web/src/components/Views/BillingView.tsx';
const service = existsSync(servicePath) ? readFileSync(servicePath, 'utf8') : '';
const route = existsSync(routePath) ? readFileSync(routePath, 'utf8') : '';
const apiClient = existsSync(apiClientPath) ? readFileSync(apiClientPath, 'utf8') : '';
const modal = existsSync(modalPath) ? readFileSync(modalPath, 'utf8') : '';
const billingView = existsSync(billingViewPath) ? readFileSync(billingViewPath, 'utf8') : '';
let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

check('script delegates to the backend HUGRAB billing service', script.includes('listHugrabBillingShippingFloorCandidates') && script.includes('applyHugrabBillingShippingFloor'));
check('script is HUGRAB-only', script.includes('HUGRAB_BILLING_CLIENT_NAME'));
check('script targets only billing shipping rows through the backend service', service.includes("billing_line_items.line_type = 'shipping'"));
check('script uses selected-rate threshold below 7.95 through the backend service', service.includes('HUGRAB_SELECTED_RATE_BELOW = 7.95') && service.includes('selected_rate_cost < ${HUGRAB_SELECTED_RATE_BELOW}'));
check('script sets billed shipping floor from TARGET_SHIPPING through the backend service', service.includes('HUGRAB_TARGET_SHIPPING = 7.73') && service.includes('HUGRAB_TARGET_SHIPPING'));
check('script is dry-run by default', script.includes('if (!apply)') && script.includes('Dry run only'));
check('script updates only after --apply through applyHugrabBillingShippingFloor', script.includes("const apply = hasFlag('apply')") && script.includes('applyHugrabBillingShippingFloor'));
check('script can revert the floor back to selected rate', script.includes("hasFlag('revert') ? 'revert' : 'floor'") && script.includes('back to Selected Rate'));
check('script supports expected row count guard', script.includes("optionalNonnegativeInt('expect')") && script.includes('Refusing to update: --expect='));
check('script does not touch orders or shipments', !/update\s+(orders|shipments)\b/i.test(script) && !/delete\s+from\s+(orders|shipments)\b/i.test(script));

check('backend service owns the HUGRAB billing shipping floor rule',
  existsSync(servicePath) &&
  service.includes("HUGRAB_BILLING_CLIENT_NAME = 'HUGRAB'") &&
  service.includes('HUGRAB_SELECTED_RATE_BELOW = 7.95') &&
  service.includes('HUGRAB_TARGET_SHIPPING = 7.73') &&
  service.includes('listHugrabBillingShippingFloorCandidates') &&
  service.includes('applyHugrabBillingShippingFloor'));
check('backend service updates billing_line_items only, never orders or shipments',
  /\.update\(billingLineItems\)/.test(service) &&
  !/update\s+(orders|shipments)\b/i.test(service) &&
  !/delete\s+from\s+(orders|shipments)\b/i.test(service));
check('backend service requires expectedCount before apply/revert',
  service.includes('expectedCount') &&
  service.includes('HugrabBillingShippingFloorCountMismatchError') &&
  service.includes('current.count !== expectedCount'));
check('backend service can preview both floor and revert candidates',
  service.includes("= 'floor' | 'revert'") &&
  service.includes('targetShipping') &&
  service.includes('selectedRateCost') &&
  service.includes('sampleRows'));

check('billing route exposes a financials:write-gated HUGRAB bulk endpoint',
  /\/hugrab-shipping-floor/.test(route) &&
  /hugrabShippingFloorSchema/.test(route) &&
  /requirePermission\('financials:write'\)/.test(route) &&
  /listHugrabBillingShippingFloorCandidates\(/.test(route) &&
  /applyHugrabBillingShippingFloor\(/.test(route));
check('billing route normalizes the selected date range through billingDayRange',
  /normalizeHugrabShippingFloorRange[\s\S]{0,180}billingDayRange\(/.test(route) &&
  /hugrabShippingFloorSchema[\s\S]{0,260}\.transform\(normalizeHugrabShippingFloorRange\)/.test(route));
check('billing route maps expected-count mismatch to HTTP 409',
  route.includes('HugrabBillingShippingFloorCountMismatchError') &&
  route.includes('409'));

check('api client has a thin HUGRAB shipping floor wrapper and clears billing caches',
  apiClient.includes('hugrabBillingShippingFloor') &&
  apiClient.includes('/billing/hugrab-shipping-floor') &&
  apiClient.includes("clearCachedReads('fetchBillingSummary', 'fetchShippingMarginAnalytics')"));
check('BillingView puts the HUGRAB bulk button next to the detail Columns control',
  billingView.includes('HugrabShippingFloorModal') &&
  billingView.includes('setDetailColumnsAnchorEl') &&
  billingView.includes('data-hugrab-shipping-floor-trigger'));
check('HUGRAB modal previews, applies, and reverts through the backend endpoint',
  existsSync(modalPath) &&
  modal.includes('data-hugrab-shipping-floor-modal') &&
  modal.includes('apiClient.hugrabBillingShippingFloor') &&
  modal.includes("selectAction('floor')") &&
  modal.includes("selectAction('revert')") &&
  modal.includes('expectedCount') &&
  modal.includes('Preview floor') &&
  modal.includes('Preview revert'));
check('HUGRAB modal gates apply/revert behind a fetched preview and confirm checkbox',
  modal.includes('confirmed') &&
  modal.includes('applyDisabled') &&
  modal.includes('!preview') &&
  modal.includes('preview.count === 0'));

if (failures > 0) {
  console.error(`\nFAIL HUGRAB billing shipping floor guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS HUGRAB billing shipping floor guard');
