import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  hasBillingLineItemNeedsReview,
  hasBillingLineItemNoBoxCost,
  summarizeBillingLineItemWarnings,
} from '../web/src/components/Views/BillingLineItemWarningSummary'
import type { BillingDetailDto } from '../web/src/components/Views/billing-parity'

const rows: BillingDetailDto[] = [
  { orderId: 101, boxCostAlert: true, billingBadges: ['NO_BOX_COST'] },
  { orderId: 102, box_cost_alert: true, billing_badges: [] },
  { orderId: 103, billingBadges: ['NO_BOX_COST'] },
  { orderId: 104, packageCostNeedsReview: true, boxCostAlert: true },
  { orderId: 105, package_cost_needs_review: 'true', box_cost_alert: true },
  { orderId: 106, boxCostAlert: false, billingBadges: [] },
]

const summary = summarizeBillingLineItemWarnings(rows)

assert.equal(summary.noBoxCost, 3, 'No-box-cost summary must count backend no-box-cost flags and badges')
assert.equal(summary.needsReview, 2, 'Needs-review summary must count backend package review flags separately')
assert.equal(hasBillingLineItemNoBoxCost(rows[0]!), true, 'Camel-case backend no-box-cost flag must count')
assert.equal(hasBillingLineItemNoBoxCost(rows[2]!), true, 'Backend NO_BOX_COST badge must count')
assert.equal(hasBillingLineItemNeedsReview(rows[4]!), true, 'Snake-case/string backend review flag must count')

const component = readFileSync('web/src/components/Views/BillingLineItemWarningSummary.tsx', 'utf8')
assert.match(component, /data-billing-line-item-warning-summary/, 'Component must expose a stable summary marker')
assert.match(component, /No box cost/, 'Component must render the No box cost summary label')
assert.match(component, /Needs review/, 'Component must render the Needs review summary label')
assert.doesNotMatch(component, /packageTotal|package_total|computeBillingDetailMetrics/, 'Summary must not infer billing warnings from local money math')

const view = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8')
assert.match(view, /import \{ BillingLineItemWarningSummary \} from '\.\/BillingLineItemWarningSummary'/, 'BillingView must import the warning summary component')
assert.match(
  view,
  /<BillingLineItemWarningSummary rows=\{sortedDetailRows\} onOpenWarningRow=\{handleOpenBillingEdit\} \/>/,
  'BillingView must render the warning summary beside the Line Items header',
)
const generateStart = view.indexOf('<h3 className="text-[13px] font-semibold text-ink">Generate &amp; summary</h3>')
const configStart = view.indexOf('<BillingConfigTable', generateStart)
const pricingStart = view.indexOf('<BillingPackagePricingTable', configStart)
const carrierTableStart = view.indexOf('<BillingCarrierMarginTable', pricingStart)
const perOrderStart = view.indexOf('Per-order reconciliation', pricingStart)
assert.ok(generateStart > -1, 'BillingView must render the Generate & summary heading')
assert.ok(configStart > generateStart, 'Client Billing Config must render inside/below Generate & summary')
assert.ok(pricingStart > configStart, 'Package Pricing by client must render next to/below Client Billing Config')
assert.ok(carrierTableStart > pricingStart, 'Config/pricing must render before the carrier margin table')
assert.ok(perOrderStart > pricingStart, 'Config/pricing must render before Per-order reconciliation')

const pkg = readFileSync('package.json', 'utf8')
assert.match(pkg, /"test:billing-line-item-warning-summary": "tsx scripts\/billing-line-item-warning-summary-guard\.ts"/, 'package.json must expose the guard script')

console.log('billing-line-item-warning-summary guard passed')
