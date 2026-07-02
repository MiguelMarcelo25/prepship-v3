/**
 * PS-363 - Billing no-box-cost alert badge.
 *
 * Missing Box Cost is a non-blocking visibility marker, not an error and not a
 * required-fix rule. Backend owns the badge decision; the frontend renders only
 * backend-provided DTO fields.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const ownerPath = 'src/services/billing-box-cost-alert.ts';
check('backend no-box-cost alert owner exists', existsSync(ownerPath));

if (existsSync(ownerPath)) {
  const {
    NO_BOX_COST_BILLING_BADGE,
    resolveBillingBoxCostAlert,
  } = await import('../src/services/billing-box-cost-alert');

  check('badge name is explicit and non-blocking',
    NO_BOX_COST_BILLING_BADGE === 'NO_BOX_COST');

  const missing = resolveBillingBoxCostAlert({
    packageCost: null,
    hasPackageCostLine: false,
    packageCostNeedsReview: false,
    isNoChargeBoxCostLine: false,
  });
  check('blank/null box cost emits NO_BOX_COST alert',
    missing.boxCostAlert === true && missing.billingBadges.includes('NO_BOX_COST'));

  const positive = resolveBillingBoxCostAlert({
    packageCost: 0.99,
    hasPackageCostLine: true,
    packageCostNeedsReview: false,
    isNoChargeBoxCostLine: false,
  });
  check('positive box cost does not emit alert',
    positive.boxCostAlert === false && !positive.billingBadges.includes('NO_BOX_COST'));

  const review = resolveBillingBoxCostAlert({
    packageCost: 0,
    hasPackageCostLine: false,
    packageCostNeedsReview: true,
    isNoChargeBoxCostLine: false,
  });
  check('existing box-review line keeps NEEDS REVIEW separate from no-box-cost alert',
    review.boxCostAlert === false && !review.billingBadges.includes('NO_BOX_COST'));

  const noCharge = resolveBillingBoxCostAlert({
    packageCost: 0,
    hasPackageCostLine: true,
    packageCostNeedsReview: false,
    isNoChargeBoxCostLine: true,
  });
  check('intentional no-charge $0 box line is not mislabeled',
    noCharge.boxCostAlert === false && !noCharge.billingBadges.includes('NO_BOX_COST'));
}

const billingService = read('src/services/billing.ts');
const billingRowSot = read('src/services/billing-detail-row-sot.ts');
const billingParity = read('web/src/components/Views/billing-parity.ts');
const billingDetailTable = read('web/src/components/Views/BillingDetailTable.tsx');
const billingNoBoxCostActionPath = 'web/src/components/Views/BillingNoBoxCostAction.tsx';
const billingNoBoxCostAction = existsSync(billingNoBoxCostActionPath) ? read(billingNoBoxCostActionPath) : '';
const billingNoBoxCostPreviewPath = 'web/src/components/Views/BillingNoBoxCostPreview.tsx';
const billingNoBoxCostPreview = existsSync(billingNoBoxCostPreviewPath) ? read(billingNoBoxCostPreviewPath) : '';
const billingView = read('web/src/components/Views/BillingView.tsx');
const packageJson = read('package.json');

check('billingDetails delegates no-box-cost decision to backend owner',
  billingService.includes("from './billing-box-cost-alert'") &&
  billingService.includes('resolveBillingBoxCostAlert({'));

check('billingDetails emits explicit DTO fields and badge list',
  /boxCostAlert:\s*boxCostAlert\.boxCostAlert/.test(billingService) &&
  /billingBadges:\s*boxCostAlert\.billingBadges/.test(billingService) &&
  /box_cost_alert:\s*boxCostAlert\.boxCostAlert/.test(billingService) &&
  /billing_badges:\s*boxCostAlert\.billingBadges/.test(billingService));

check('backend order-row SOT carries no-box-cost badge fields through grouped rows',
  billingRowSot.includes("'boxCostAlert'") &&
  billingRowSot.includes("'box_cost_alert'") &&
  billingRowSot.includes("'billingBadges'") &&
  billingRowSot.includes("'billing_badges'"));

check('frontend compatibility aggregator ORs/carries backend no-box-cost fields',
  billingParity.includes('boxCostAlert') &&
  billingParity.includes('billingBadges') &&
  !/metrics\.packageCost\s*===?\s*0[\s\S]{0,120}NO_BOX_COST/.test(billingParity));

check('Billing table delegates backend-provided NO_BOX_COST badge copy',
  billingDetailTable.includes('hasBillingNoBoxCostAlert(row)') &&
  billingDetailTable.includes('<BillingNoBoxCostAction row={row} onOpenBillingEdit={onOpenBillingEdit} />') &&
  !billingDetailTable.includes('Box Cost required'));

check('row-level NO_BOX_COST badge is a clickable edit action',
  existsSync(billingNoBoxCostActionPath) &&
  billingDetailTable.includes("from './BillingNoBoxCostAction'") &&
  billingDetailTable.includes('<BillingNoBoxCostAction') &&
  billingNoBoxCostAction.includes('data-billing-badge="NO_BOX_COST"') &&
  billingNoBoxCostAction.includes('type="button"') &&
  billingNoBoxCostAction.includes('onOpenBillingEdit(row)') &&
  !billingNoBoxCostAction.includes('informational only'));

check('NO_BOX_COST edit modal explains Box Cost can be fixed',
  billingView.includes('hasBillingNoBoxCostAlert(billingEditModal.row)') &&
  billingView.includes('<BillingNoBoxCostPreview') &&
  billingNoBoxCostPreview.includes('No box cost') &&
  billingNoBoxCostPreview.includes('Enter the Box Cost') &&
  billingView.includes('<span>Box Cost</span>'));

check('NO_BOX_COST edit modal previews every current no-box-cost row',
  existsSync(billingNoBoxCostPreviewPath) &&
  billingView.includes("from './BillingNoBoxCostPreview'") &&
  billingView.includes('billingNoBoxCostRows') &&
  billingView.includes('<BillingNoBoxCostPreview') &&
  billingView.includes('rows={billingNoBoxCostRows}') &&
  billingView.includes('activeRow={billingEditModal.row}') &&
  billingNoBoxCostPreview.includes('No box cost preview') &&
  billingNoBoxCostPreview.includes('rows need box cost') &&
  billingNoBoxCostPreview.includes('onOpenBillingEdit(row)') &&
  billingNoBoxCostPreview.includes('max-h-') &&
  billingNoBoxCostPreview.includes('overflow-y-auto'));

check('package.json wires the PS-363 guard',
  packageJson.includes('"test:ps-363-billing-no-box-cost-alert"'));

if (failures > 0) {
  console.error(`\nFAIL PS-363 Billing no-box-cost alert guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-363 Billing no-box-cost alert guard');
