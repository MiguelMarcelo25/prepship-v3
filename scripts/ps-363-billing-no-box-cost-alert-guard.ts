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

  // PS-372(b): the alert consumes the EMITTER's gate. A client with no
  // configured box pricing gets no box line by decidePackageCostLine's own
  // first gate — so the missing-cost alert must not flag it either.
  const unpricedClient = resolveBillingBoxCostAlert({
    packageCost: null,
    hasPackageCostLine: false,
    packageCostNeedsReview: false,
    isNoChargeBoxCostLine: false,
    canAlertMissing: true,
    clientHasBoxPricing: false,
  });
  check('PS-372(b): unpriced client (emitter suppresses the line) does NOT get the alert',
    unpricedClient.boxCostAlert === false && !unpricedClient.billingBadges.includes('NO_BOX_COST'));
  const pricedClientMissing = resolveBillingBoxCostAlert({
    packageCost: null,
    hasPackageCostLine: false,
    packageCostNeedsReview: false,
    isNoChargeBoxCostLine: false,
    canAlertMissing: true,
    clientHasBoxPricing: true,
  });
  check('PS-372(b): priced client with a genuinely missing box cost STILL alerts',
    pricedClientMissing.boxCostAlert === true && pricedClientMissing.billingBadges.includes('NO_BOX_COST'));
  const unknownGate = resolveBillingBoxCostAlert({
    packageCost: null,
    hasPackageCostLine: false,
    packageCostNeedsReview: false,
    isNoChargeBoxCostLine: false,
    canAlertMissing: true,
  });
  check('PS-372(b): callers that do not know the gate keep the historical alert behavior',
    unknownGate.boxCostAlert === true);
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
// The billing-view decomposition (d9942d62) split the edit-modal markup into
// BillingEditDetailModal and the modal mounting into BillingDetailModalStack.
const billingEditModal = read('web/src/components/Views/BillingEditDetailModal.tsx');
const billingModalStack = read('web/src/components/Views/BillingDetailModalStack.tsx');
const packageJson = read('package.json');

check('billingDetails delegates no-box-cost decision to backend owner',
  billingService.includes("from './billing-box-cost-alert'") &&
  billingService.includes('resolveBillingBoxCostAlert({'));

// PS-368: the detail-row boundary is camelCase-only — the snake mirrors are deleted.
check('billingDetails emits explicit DTO fields and badge list (camelCase-only)',
  /boxCostAlert:\s*boxCostAlert\.boxCostAlert/.test(billingService) &&
  /billingBadges:\s*boxCostAlert\.billingBadges/.test(billingService) &&
  !/box_cost_alert:\s*boxCostAlert\.boxCostAlert/.test(billingService) &&
  !/billing_badges:\s*boxCostAlert\.billingBadges/.test(billingService));

check('backend order-row SOT carries no-box-cost badge fields through grouped rows (camelCase-only)',
  billingRowSot.includes("'boxCostAlert'") &&
  billingRowSot.includes("'billingBadges'") &&
  !billingRowSot.includes("'box_cost_alert'") &&
  !billingRowSot.includes("'billing_badges'"));

// PS-372(b): the emitter's gate is threaded end-to-end — billingDetails loads it
// per client, stamps rows, and the SOT's alert passthrough consumes it.
check('PS-372(b): billingDetails threads clientHasBoxPricing (emitter gate) onto detail rows',
  /boxPricingByClient/.test(billingService) &&
  /clientHasBoxPricing: row\.clientId != null \? boxPricingByClient\.get\(row\.clientId\)/.test(billingService));
check('PS-372(b): the SOT alert passthrough consumes the emitter gate (tri-state)',
  /clientHasBoxPricing:/.test(billingRowSot));

// PS-369: the FE compatibility aggregator is DELETED — the backend order-row SOT
// is the only aggregator, and the FE renders its boxCostAlert/billingBadges
// verbatim (BillingNoBoxCostAction reads the row fields directly).
check('frontend does not re-derive the no-box-cost decision (aggregator deleted, no money-based badge)',
  !/function aggregateBillingDetailRowsByOrder/.test(billingParity) &&
  !/metrics\.packageCost\s*===?\s*0[\s\S]{0,120}NO_BOX_COST/.test(billingParity) &&
  billingNoBoxCostAction.includes('boxCostAlert'));

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

// d9942d62 decomposition: the edit-modal markup lives in BillingEditDetailModal,
// the modal mounting in BillingDetailModalStack; BillingView still owns the row
// list + handlers and threads them down. Same user outcome, new owners.
check('NO_BOX_COST edit modal explains Box Cost can be fixed',
  billingEditModal.includes('hasBillingNoBoxCostAlert(row)') &&
  billingEditModal.includes('<BillingNoBoxCostPreview') &&
  billingNoBoxCostPreview.includes('No box cost') &&
  billingNoBoxCostPreview.includes('Enter the Box Cost') &&
  billingEditModal.includes('<span>Box Cost</span>'));

check('NO_BOX_COST edit modal previews every current no-box-cost row',
  existsSync(billingNoBoxCostPreviewPath) &&
  billingEditModal.includes("from './BillingNoBoxCostPreview'") &&
  billingView.includes('billingNoBoxCostRows') &&
  billingView.includes('noBoxCostRows={billingNoBoxCostRows}') &&
  billingEditModal.includes('<BillingNoBoxCostPreview') &&
  billingEditModal.includes('rows={noBoxCostRows}') &&
  billingEditModal.includes('activeRow={row}') &&
  billingNoBoxCostPreview.includes('No box cost preview') &&
  billingNoBoxCostPreview.includes('rows need box cost') &&
  billingNoBoxCostPreview.includes('onOpenBillingEdit(row)') &&
  billingNoBoxCostPreview.includes('max-h-') &&
  billingNoBoxCostPreview.includes('overflow-y-auto'));

check('NO_BOX_COST preview offers same-box bulk apply through the backend bulk box-cost flow',
  billingNoBoxCostPreview.includes('onBulkApplyBoxCost') &&
  billingNoBoxCostPreview.includes('data-billing-no-box-cost-bulk') &&
  billingNoBoxCostPreview.includes('sameBoxRows.length') &&
  billingView.includes('handleOpenNoBoxCostBulkApply') &&
  billingView.includes('onOpenNoBoxCostBulkApply={handleOpenNoBoxCostBulkApply}') &&
  billingEditModal.includes('onBulkApplyBoxCost={onOpenNoBoxCostBulkApply}') &&
  billingModalStack.includes('<BulkBoxCostModal') &&
  billingModalStack.includes('initialCost=') &&
  read('web/src/components/Views/BulkBoxCostModal.tsx').includes('initialCost?:'));

check('package.json wires the PS-363 guard',
  packageJson.includes('"test:ps-363-billing-no-box-cost-alert"'));

if (failures > 0) {
  console.error(`\nFAIL PS-363 Billing no-box-cost alert guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-363 Billing no-box-cost alert guard');
