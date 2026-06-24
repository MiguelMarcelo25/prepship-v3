/**
 * PS-312 (S1) — REAL execution test for bundle-candidate detection. Proves same-recipient awaiting
 * orders group into a candidate, and that shipped/cancelled/labelled/already-bundled/different-
 * client/different-recipient orders are all correctly EXCLUDED. Pure/offline — no DB.
 */
import {
  findBundleCandidates,
  isBundleEligible,
  normalizeRecipientIdentity,
  type BundleCandidateOrder,
} from '../src/services/shipment-bundles/bundle-candidates';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function order(partial: Partial<BundleCandidateOrder> & { orderId: number }): BundleCandidateOrder {
  return {
    orderNumber: `ORD-${partial.orderId}`,
    clientId: 100,
    storeId: 1,
    shipToName: 'Sze Ting Lee',
    shipToCity: 'San Gabriel',
    shipToState: 'CA',
    shipToPostalCode: '91776',
    orderStatus: 'awaiting_shipment',
    hasActiveLabel: false,
    existingBundleId: null,
    ...partial,
  };
}

// Two awaiting orders, same recipient + client/store → ONE candidate group of 2.
const base = [order({ orderId: 1778 }), order({ orderId: 1777 })];
let groups = findBundleCandidates(base);
check('same-recipient awaiting pair → 1 candidate group of 2',
  groups.length === 1 && groups[0].orderIds.sort((a, b) => a - b).join(',') === '1777,1778');

// Recipient identity normalizes case/whitespace.
check('recipient identity normalizes case + whitespace',
  normalizeRecipientIdentity({ shipToName: '  SZE  TING lee ', shipToCity: 'San Gabriel', shipToState: 'ca', shipToPostalCode: '91776' }) ===
  normalizeRecipientIdentity({ shipToName: 'Sze Ting Lee', shipToCity: 'san gabriel', shipToState: 'CA', shipToPostalCode: '91776' }));

// A different recipient is NOT grouped with the pair.
groups = findBundleCandidates([...base, order({ orderId: 1779, shipToName: 'Someone Else', shipToPostalCode: '90001' })]);
check('a different recipient is excluded from the group', groups.length === 1 && !groups[0].orderIds.includes(1779));

// Shipped / cancelled / voided are excluded.
check('shipped order is NOT eligible', !isBundleEligible(order({ orderId: 9, orderStatus: 'shipped' })));
check('cancelled order is NOT eligible', !isBundleEligible(order({ orderId: 9, orderStatus: 'cancelled' })));
groups = findBundleCandidates([order({ orderId: 1778 }), order({ orderId: 1777, orderStatus: 'shipped' })]);
check('a pair where one is shipped → NO candidate (only 1 eligible)', groups.length === 0);

// Already-labelled / already-bundled are excluded.
check('an order with an active label is NOT eligible', !isBundleEligible(order({ orderId: 9, hasActiveLabel: true })));
check('an already-bundled order is NOT eligible', !isBundleEligible(order({ orderId: 9, existingBundleId: 5 })));

// Different client/store are not grouped together even with the same recipient.
groups = findBundleCandidates([order({ orderId: 1778, clientId: 100 }), order({ orderId: 1777, clientId: 200 })]);
check('same recipient but DIFFERENT client → not grouped (scope isolation)', groups.length === 0);

// A blank recipient can never be a candidate.
check('blank recipient is NOT eligible',
  !isBundleEligible(order({ orderId: 9, shipToName: '', shipToCity: '', shipToState: '', shipToPostalCode: '' })));

// A lone awaiting order with no sibling is not a candidate.
check('a single awaiting order → no candidate', findBundleCandidates([order({ orderId: 1778 })]).length === 0);

if (failures > 0) {
  console.error(`\nPS-312 bundle-candidates guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-312 bundle-candidates guard passed.');
