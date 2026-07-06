/**
 * PS-394 - Billing Qty display + split-row shipping clarity.
 *
 * Offline guard. It pins the backend detail read model as the source of truth:
 * whole-unit quantities display without decimals, orphan adjustment/package
 * rows attach to the unique order row by order number, and the FE renders the
 * backend display field instead of raw billing_line_items.qty.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toBillingDetailOrderRows } from '../src/services/billing-detail-row-sot';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name} - ${err instanceof Error ? err.message : err}`);
  }
}

check('whole-unit raw qty strings display without decimals', () => {
  const [row] = toBillingDetailOrderRows([
    {
      id: 1,
      orderId: 39401,
      orderNumber: 'PS394-QTY',
      lineType: 'pick_pack',
      qty: '1.00',
      totalCost: '2.50',
    },
  ]);

  assert.equal(row.displayQty, '1');
});

check('non-whole measurement qty keeps decimal precision without trailing zero noise', () => {
  const [row] = toBillingDetailOrderRows([
    {
      id: 2,
      orderNumber: null,
      lineType: 'storage',
      description: 'Storage',
      qty: '2.50',
      totalCost: '10.00',
    },
  ]);

  assert.equal(row.displayQty, '2.5');
});

check('unique order-number orphan package row collapses into the shipped order row', () => {
  const rows = toBillingDetailOrderRows([
    {
      id: 10,
      orderId: null,
      orderNumber: '1008',
      lineType: 'package_cost',
      description: 'Box (12x10x3)',
      qty: '1.00',
      totalCost: '0.65',
      packageName: '12x10x3',
    },
    {
      id: 11,
      orderId: 1008,
      orderNumber: '1008',
      lineType: 'shipping',
      qty: '1.00',
      totalCost: '8.17',
      selectedRateCost: '8.17',
      trackingNumber: '9400100000000001008',
      carrierNickname: 'USPS',
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].orderId, 1008);
  assert.equal(rows[0].orderNumber, '1008');
  assert.equal(rows[0].packageTotal, 0.65);
  assert.equal(rows[0].shippingTotal, 8.17);
  assert.equal(rows[0].selectedRateCost, '8.17');
  assert.equal(rows[0].trackingNumber, '9400100000000001008');
  assert.equal(rows[0].displayQty, '1');
});

check('duplicate local order numbers stay separate and get diagnostic badges', () => {
  const rows = toBillingDetailOrderRows([
    {
      id: 20,
      orderId: 2001,
      orderNumber: 'DUP-1008',
      lineType: 'package_cost',
      qty: '1.00',
      totalCost: '0.65',
    },
    {
      id: 21,
      orderId: 2002,
      orderNumber: 'DUP-1008',
      lineType: 'shipping',
      qty: '1.00',
      totalCost: '8.17',
    },
  ]);

  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => Array.isArray(row.billingBadges)));
  assert.ok(rows.every((row) => row.billingBadges.includes('Duplicate order #')));
});

const sot = read('src/services/billing-detail-row-sot.ts');
const table = read('web/src/components/Views/BillingDetailTable.tsx');
const view = read('web/src/components/Views/BillingView.tsx');
const parity = read('web/src/components/Views/billing-parity.ts');
const pkg = read('package.json');

check('backend DTO owns displayQty and order-number orphan attachment', () => {
  assert.match(sot, /displayQty\?: string/);
  assert.match(sot, /function formatBillingDisplayQty/);
  assert.match(sot, /uniqueOrderKeyByOrderNumber/);
});

check('frontend renders formatted display qty instead of raw qty strings', () => {
  assert.match(parity, /export function billingDetailQtyDisplay/);
  assert.match(table, /billingDetailQtyDisplay\(row\)/);
  assert.doesNotMatch(table, /row\.totalQty \|\| row\.qty \|\| 0/);
});

check('frontend sorts qty using numeric helper, not raw qty strings', () => {
  assert.match(parity, /export function billingDetailQtySortValue/);
  assert.match(table, /billingDetailQtySortValue\(row\)/);
  assert.match(view, /billingDetailQtySortValue\(row\)/);
});

check('package.json wires the PS-394 guard', () => {
  assert.match(pkg, /"test:ps-394-billing-qty-shipping-display":\s*"tsx scripts\/ps-394-billing-qty-shipping-display-guard\.ts"/);
});

if (failures > 0) {
  console.error(`\nFAIL PS-394 billing qty/shipping display guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-394 billing qty/shipping display guard');
