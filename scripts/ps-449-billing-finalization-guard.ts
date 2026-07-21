import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`)
  return source.slice(from, to)
}

const policy = read('src/services/billing-finalization-policy.ts')
const billingService = read('src/services/billing.ts')
const route = read('src/routes/billing.ts')
const migration = read('drizzle/0065_billing_close_workflow.sql')
const view = read('web/src/components/Views/BillingView.tsx')
const panel = read('web/src/components/Views/BillingCloseWorkflowPanel.tsx')
const browserProof = read('web/e2e/billing-close-workflow.spec.js')
const placement = read('docs/ps-tickets/PS-449.md')
const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
const sotPack = read('scripts/sot-guard-pack.mjs')

const finalizePolicy = sliceBetween(
  policy,
  'export async function finalizeBillingPeriod',
  'export async function listBillingCreditNotes',
)
const creditPolicy = sliceBetween(
  policy,
  'export async function createBillingCreditNote',
  'export function billingLineItemIsEditablePredicate',
)
const generator = sliceBetween(
  billingService,
  'export async function generateLineItems',
  'export type BillingSummaryRow',
)
const finalizeRoute = sliceBetween(route, "app.post(\n  '/finalize'", "app.get('/finalizations'")
const creditRoute = sliceBetween(route, "app.post(\n  '/credit-notes'", "app.get('/credit-notes'")

// Canonical close owner: one client-scoped transaction serializes admission,
// freezes exact backend invoice totals, and appends the immutable close fact.
assert.match(finalizePolicy, /conn\.transaction\(async \(tx\) =>/)
assert.match(finalizePolicy, /pg_advisory_xact_lock\(36421, \$\{input\.clientId\}\)/)
assert.match(finalizePolicy, /order by \$\{billingLineItems\.id\}[\s\S]*?for update/)
assert.match(finalizePolicy, /billingInvoiceHeaderTotals\(/)
assert.match(finalizePolicy, /set \$\{billingLineItems\.invoiced\} = true/)
assert.match(finalizePolicy, /insert into \$\{billingFinalizations\}/)
assert.ok(
  finalizePolicy.indexOf('pg_advisory_xact_lock') < finalizePolicy.indexOf('for update') &&
    finalizePolicy.indexOf('for update') < finalizePolicy.indexOf('billingInvoiceHeaderTotals(') &&
    finalizePolicy.indexOf('billingInvoiceHeaderTotals(') < finalizePolicy.indexOf('insert into ${billingFinalizations}'),
  'finalization must lock, freeze totals, then append the close record in that order',
)

// Regeneration refuses a closed period before generator reads or writes. The
// migration trigger takes the same client advisory lock, closing the race where
// finalize and generate begin concurrently.
assert.match(generator, /await assertBillingPeriodOpen\(/)
assert.ok(
  generator.indexOf('await assertBillingPeriodOpen(') < generator.indexOf('await db.transaction('),
  'period-open admission must precede billing regeneration writes',
)
assert.match(migration, /CREATE OR REPLACE FUNCTION billing_finalizations_block_overlap\(\)[\s\S]*?pg_advisory_xact_lock\(36421, NEW\.client_id\)/i)
assert.match(migration, /CREATE OR REPLACE FUNCTION billing_line_items_block_closed_period_mutation\(\)[\s\S]*?pg_advisory_xact_lock\(36421, lock_client_id\)/i)
assert.match(migration, /billing_line_items_closed_period_guard[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE ON billing_line_items/i)
assert.match(migration, /billing_finalizations_no_update_delete/)
assert.match(migration, /billing_finalizations_no_truncate/)

// Post-close corrections are reasoned, idempotent, balance-bounded, append-only
// credit notes. The service and database each enforce the money boundary.
assert.match(creditPolicy, /normalizeCreditAmount\(input\.amount\)/)
assert.match(creditPolicy, /reason = input\.reason\.trim\(\)/)
assert.match(creditPolicy, /pg_advisory_xact_lock\(36422, hashtext\(\$\{idempotencyKey\}\)\)/)
assert.match(creditPolicy, /for update/)
assert.match(creditPolicy, /BILLING_CREDIT_IDEMPOTENCY_CONFLICT/)
assert.match(creditPolicy, /BILLING_CREDIT_EXCEEDS_BALANCE/)
assert.match(creditPolicy, /insert into \$\{billingCreditNotes\}/)
assert.match(migration, /billing_credit_notes_balance_guard/)
assert.match(migration, /billing_credit_notes_no_update_delete/)
assert.match(migration, /billing_credit_notes_no_truncate/)

// HTTP handlers carry authenticated, scoped intent to the policy and record the
// resulting backend fact. They do not reproduce close or credit calculations.
for (const handler of [finalizeRoute, creditRoute]) {
  assert.match(handler, /requirePermission\('financials:write'\)/)
  assert.match(handler, /canAccessBillingClient\(/)
  assert.match(handler, /auditActorFromContext\(c\)/)
  assert.match(handler, /if \(!actor\.actorId\)/)
  assert.match(handler, /recordAuditEvent\(/)
}
assert.match(finalizeRoute, /finalizeBillingPeriod\(/)
assert.match(creditRoute, /createBillingCreditNote\(/)
assert.doesNotMatch(finalizeRoute, /billingInvoiceHeaderTotals|insert into|\.transaction\(/)
assert.doesNotMatch(creditRoute, /moneyCents|insert into|\.transaction\(/)

// React renders backend totals and sends operator intent only. It never derives
// an authoritative remaining balance or mutates finalized rows locally.
assert.match(view, /api\.post[\s\S]*?'\/billing\/finalize'/)
assert.match(view, /api\.post[\s\S]*?'\/billing\/credit-notes'/)
assert.match(view, /readOnlyReason=\{billingPeriodReadOnlyReason\}/)
for (const field of ['subtotal', 'creditedAmount', 'balance']) {
  assert.ok(panel.includes(`selectedFinalization.${field}`), `panel renders backend ${field}`)
}
assert.doesNotMatch(panel, /subtotal\s*[-+]\s*creditedAmount|creditedAmount\s*[-+]\s*subtotal/)

// Offline workflow proof must follow the current backend-owned date-window
// contract and exercise both operator intents without live API traffic.
assert.match(browserProof, /path === '\/billing\/preset-window'/)
assert.match(browserProof, /path === '\/billing\/finalize'[\s\S]*?request\.method\(\) === 'POST'/)
assert.match(browserProof, /path === '\/billing\/credit-notes'[\s\S]*?request\.method\(\) === 'POST'/)
assert.match(browserProof, /toHaveAttribute\('data-billing-period-locked', 'true'\)/)
assert.match(browserProof, /billing-detail-edit-button[\s\S]*?toBeDisabled\(\)/)
assert.match(browserProof, /Carrier service refund/)

assert.match(placement, /Canonical owner/)
assert.match(placement, /89a31558/)
assert.match(placement, /283061e5/)
assert.equal(
  packageJson.scripts?.['test:ps-449-billing-finalization'],
  'tsx scripts/ps-449-billing-finalization-guard.ts',
)
assert.match(sotPack, /'test:ps-449-billing-finalization'/)

console.log('PASS PS-449 billing finalization certification guard')
