/**
 * Guard for the clean C. Shipping Rate money model.
 *
 * Public/runtime money DTOs expose only:
 *   - cShippingRateAmount: customer-billed shipping amount
 *   - selectedRateCost: actual paid/selected label cost
 *   - shippingMarginAmount: cShippingRateAmount - selectedRateCost
 *
 * Legacy aliases are allowed only in the backend normalization boundary and this guard.
 */
import { existsSync, readFileSync } from 'node:fs';

import { decideShippingLineBilling } from '../src/services/billing-shipping-line.js';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto.js';
import { redactRateBrowserMoney } from '../src/services/rate-browser-money-redaction.js';
import { redactOrderFinancials } from '../src/services/orders-financial-redaction.js';
import { buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money.js';

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
  return readFileSync(path, 'utf8');
}

function containsLegacyMoneyName(source: string): boolean {
  return /customerShippingRateAmount|customer_shipping_rate_amount|customerRateAmount|customer_rate_amount|houseCustomerRate|house_customer_rate|houseRateAmount|house_rate_amount|rateCostAmount|rate_cost_amount/.test(source);
}

const rowMoney = buildOrderRowMoneyDisplay({
  isAwaiting: true,
  bestRateBaseAmount: 5,
  selectedRateBaseAmount: null,
  labelFinalCost: null,
  markupRule: null,
  insuranceAddOn: null,
  houseMarkedAmount: 8,
}) as any;

check(
  'row money exposes only canonical cShippingRateAmount, selectedRateCost, shippingMarginAmount',
  rowMoney?.cShippingRateAmount === 8 &&
    rowMoney.selectedRateCost === 5 &&
    rowMoney.shippingMarginAmount === 3 &&
    !('customerShippingRateAmount' in rowMoney) &&
    !('customerRateAmount' in rowMoney) &&
    !('rateCostAmount' in rowMoney) &&
    !('houseRateAmount' in rowMoney),
  rowMoney,
);

const normalized = normalizeOrderBestRateDto({
  shipmentCost: 5,
  otherCost: 0,
  totalCost: 5,
  cShippingRateAmount: 12,
  selectedRateCost: 5,
  serviceCode: 'ups_ground',
  carrierCode: 'ups',
} as any) as any;

check(
  'OrderBestRateDto exposes only canonical cShippingRateAmount, selectedRateCost, shippingMarginAmount',
  normalized?.cShippingRateAmount === 12 &&
    normalized.selectedRateCost === 5 &&
    normalized.shippingMarginAmount === 7 &&
    !('customerShippingRateAmount' in normalized) &&
    !('customerRateAmount' in normalized) &&
    !('rateCostAmount' in normalized) &&
    !('houseRateAmount' in normalized),
  normalized,
);

const billingDecision = decideShippingLineBilling({
  labelCost: 5,
  cShippingRateAmount: 8,
  billingMode: 'label_cost',
  isBaselineCarrier: false,
  refUspsRate: 7,
  refUpsRate: 9,
  shippingMarkupPct: 0,
  shippingMarkupFlat: 0,
} as any);

check(
  'billing decision uses c_shipping_rate source when C. Shipping Rate is present',
  billingDecision.billedAmount === 8 && billingDecision.source === 'c_shipping_rate',
  billingDecision,
);

const redactedOrder = redactOrderFinancials({ shipping: { cShippingRateAmount: 12, selectedRateCost: 5 } }, false) as any;
check(
  'order financial redaction scrubs canonical shipping money fields',
  redactedOrder.shipping.cShippingRateAmount === null &&
    redactedOrder.shipping.selectedRateCost === null,
  redactedOrder,
);

const redactedRateBrowser = redactRateBrowserMoney({
  bestRate: { cShippingRateAmount: 12, selectedRateCost: 5 },
}) as any;
check(
  'rate browser redaction scrubs canonical shipping money fields',
  redactedRateBrowser.bestRate.cShippingRateAmount === null &&
    redactedRateBrowser.bestRate.selectedRateCost === null,
  redactedRateBrowser,
);

check(
  'one backend compatibility normalizer owns legacy aliases',
  existsSync('src/services/shipping-workflow/shipping-rate-money-normalizer.ts'),
);

check(
  'frontend money readers use clean names without alias fallback chains',
  !containsLegacyMoneyName(read('web/src/lib/rate-browser-money.ts')) &&
    !containsLegacyMoneyName(read('web/src/components/Views/orders-row-display.tsx')) &&
    !containsLegacyMoneyName(read('web/src/components/Views/orders-rate-cells.tsx')) &&
    !containsLegacyMoneyName(read('web/src/components/Views/orders-table-columns.ts')) &&
    !containsLegacyMoneyName(read('web/src/components/Views/orders/best-rate-price-display.ts')) &&
    !containsLegacyMoneyName(read('web/src/components/Views/orders/cells/order-cells.tsx')) &&
    !containsLegacyMoneyName(read('web/src/components/Views/OrdersDetailSidePanel.tsx')) &&
    !containsLegacyMoneyName(read('web/src/lib/v2-apiClient/shared.ts')),
);

check(
  'billing decision uses cShippingRateAmount and no legacy rate names',
  /cShippingRateAmount/.test(read('src/services/billing-shipping-line.ts')) &&
    !containsLegacyMoneyName(read('src/services/billing-shipping-line.ts')),
);

check(
  'backend money producers expose only canonical shipping money names',
  !containsLegacyMoneyName(read('src/services/shipping-workflow/rate-money.ts')) &&
    !containsLegacyMoneyName(read('src/services/order-rate-dto.ts')) &&
    !containsLegacyMoneyName(read('src/services/rates-combined.ts')) &&
    !containsLegacyMoneyName(read('src/services/shipping-workflow/house-tuple-stamp.ts')) &&
    !containsLegacyMoneyName(read('src/services/shipping-workflow/purchase-customer-rate-aliases.ts')),
);

if (failures > 0) {
  console.error(`\nFAIL customer shipping rate naming guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS customer shipping rate naming guard');
