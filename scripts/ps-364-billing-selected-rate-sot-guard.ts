/**
 * PS-364 - Billing selected-rate source of truth.
 *
 * Billing rows are shipped orders, so the rate column must show the selected /
 * purchased shipment rate, not Awaiting "Best Rate" semantics or base postage
 * without insurance/other fees.
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

const ownerPath = 'src/services/billing-selected-rate-cost.ts';
check('backend selected-rate cost owner exists', existsSync(ownerPath));

if (existsSync(ownerPath)) {
  const { resolveBillingSelectedRateCost } = await import('../src/services/billing-selected-rate-cost');

  check('selected rate uses full purchased cost plus insurance/other cost',
    resolveBillingSelectedRateCost({
      cost: '5.73',
      labelCost: '5.73',
      otherCost: '1.09',
      selectedRateJson: { totalCost: 5.73 },
    }) === 6.82);

  check('selected rate falls back to label cost plus other cost when synced cost is absent',
    resolveBillingSelectedRateCost({
      cost: null,
      labelCost: '7.25',
      otherCost: '1.09',
      selectedRateJson: null,
    }) === 8.34);

  check('selected rate can use selected-rate JSON total when shipment costs are missing',
    resolveBillingSelectedRateCost({
      cost: null,
      labelCost: null,
      otherCost: null,
      selectedRateJson: { totalCost: 9.44 },
    }) === 9.44);
}

const billingService = read('src/services/billing.ts');
const billingRowSot = read('src/services/billing-detail-row-sot.ts');
const billingParity = read('web/src/components/Views/billing-parity.ts');
const billingView = read('web/src/components/Views/BillingView.tsx');
const billingDetailTable = read('web/src/components/Views/BillingDetailTable.tsx');
const billingEditModal = read('web/src/components/Views/BillingEditDetailModal.tsx');
const packageJson = read('package.json');

check('billingDetails delegates selected-rate cost to the backend owner',
  billingService.includes("from './billing-selected-rate-cost'") &&
  billingService.includes('resolveBillingSelectedRateCost({'));

check('billingDetails emits selectedRateCost and a deprecated compatibility alias',
  /selectedRateCost:\s*isShippingLine \? selectedRateCost : null/.test(billingService) &&
  /actualLabelCost:\s*isShippingLine \? selectedRateCost : null/.test(billingService));

// PS-368: the detail-row boundary is camelCase-only (BillingDetailRowDto); the
// snake_case 'selected_rate_cost' twin was intentionally removed from the SOT
// carry fields. camelCase-only is the contract (ps-362 pins no snake duplicates).
check('backend order-row SOT carries selectedRateCost (camelCase-only) through grouped detail rows',
  billingRowSot.includes("'selectedRateCost'") &&
  !billingRowSot.includes("'selected_rate_cost'"));

check('Billing detail column is Selected Rate, not Best Rate',
  billingParity.includes("{ id: 'selectedRate', label: 'Selected Rate'") &&
  !billingParity.includes("{ id: 'bestRate', label: 'Best Rate'"));

check('Billing detail metrics use selectedRateCost as the money source',
  /selectedRateCost\s*=\s*detail\.selectedRateCost/.test(billingParity) &&
  /const ourCost = Number\(selectedRateCost \?\? 0\)/.test(billingParity));

check('Billing table renders selectedRateCost and no bestRate data marker',
  billingDetailTable.includes("case 'selectedRate':") &&
  billingDetailTable.includes('row.selectedRateCost ?? row.selected_rate_cost') &&
  billingDetailTable.includes('data-billing-rate="selectedRate"') &&
  !billingDetailTable.includes('data-billing-rate="bestRate"'));

check('Billing view sort and edit modal use Selected Rate copy',
  billingView.includes("case 'selectedRate':") &&
  billingEditModal.includes('<span>Selected Rate</span>') &&
  !billingEditModal.includes('<span>Best Rate</span>'));

check('package.json wires the PS-364 guard',
  packageJson.includes('"test:ps-364-billing-selected-rate-sot"'));

if (failures > 0) {
  console.error(`\nFAIL PS-364 Billing selected-rate SOT guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-364 Billing selected-rate SOT guard');
