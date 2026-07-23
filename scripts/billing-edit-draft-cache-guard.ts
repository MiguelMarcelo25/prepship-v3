import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  billingEditDraftForRow,
  billingEditDraftKey,
  clearBillingEditDraft,
  rememberBillingEditDraft,
  type BillingEditDraft,
} from '../web/src/components/Views/billing-edit-draft-cache'
import type { BillingDetailDto } from '../web/src/components/Views/billing-parity'

const draft = (packageCost: string): BillingEditDraft => ({
  pickPack: '2.50',
  additional: '0.00',
  packageCost,
  shipping: '7.95',
  packageId: '12',
  reason: 'Operator correction',
})

const rowA: BillingDetailDto = {
  orderId: 2115,
  orderNumber: '2115',
  packageId: 12,
  packageName: '9x6x3',
  boxCostAlert: true,
}

const rowB: BillingDetailDto = {
  orderId: 2112,
  orderNumber: '2112',
  packageId: 12,
  packageName: '9x6x3',
  boxCostAlert: true,
}

const rowDifferentBox: BillingDetailDto = {
  orderId: 2059,
  orderNumber: '2059',
  packageId: 14,
  packageName: '12x10x3',
  boxCostAlert: true,
}

assert.equal(billingEditDraftKey(rowA), 'order:2115', 'draft key should be stable by order id')

const cached = rememberBillingEditDraft({}, rowA, draft('0.99'))
assert.deepEqual(
  billingEditDraftForRow(cached, rowA, draft('0.00')),
  draft('0.99'),
  'reopening the same preview row must keep the unsaved box cost draft',
)

assert.equal(
  billingEditDraftForRow(cached, rowB, draft('0.00')).packageCost,
  '0.00',
  'switching orders must never carry a box-cost draft, even when both rows use the same box',
)

assert.equal(
  billingEditDraftForRow(cached, rowDifferentBox, draft('0.00')).packageCost,
  '0.00',
  'switching to a different box must not carry the previous box cost',
)

assert.deepEqual(
  clearBillingEditDraft(cached, rowA),
  {},
  'saved/cancelled rows can be cleared from the draft cache',
)

const billingView = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8')
const billingDraftCache = readFileSync('web/src/components/Views/billing-edit-draft-cache.ts', 'utf8')
assert.match(
  billingView,
  /billingEditDraftCacheRef/,
  'BillingView must keep a modal-session draft cache instead of rebuilding from the clicked row only',
)
assert.match(
  billingView,
  /billingEditDraftForRow/,
  'BillingView must restore only the selected order\'s cached draft',
)
assert.doesNotMatch(
  `${billingView}\n${billingDraftCache}`,
  /carryFrom|sameBillingBox/,
  'frontend billing drafts must not infer or carry box-cost money across orders',
)

console.log('billing edit draft cache guard passed')
