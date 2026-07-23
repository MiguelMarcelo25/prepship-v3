import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const view = read('web/src/components/Views/BillingView.tsx');
const panel = read('web/src/components/Views/BillingCloseWorkflowPanel.tsx');
const detailTable = read('web/src/components/Views/BillingDetailTable.tsx');
const lineHeader = read('web/src/components/Views/BillingLineItemsHeader.tsx');
const route = read('src/routes/billing.ts');
const policy = read('src/services/billing-finalization-policy.ts');
const browserSpec = read('web/e2e/billing-close-workflow.spec.js');
const placement = read('docs/ps-tickets/audit-5.7-billing-close-workflow-ux.md');
const audit = read('AUDIT-2026-07-13.md');
const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const sotPack = read('scripts/sot-guard-pack.mjs');

for (const literal of [
  '/billing/finalizations',
  '/billing/finalize',
  '/billing/credit-notes',
]) {
  assert.ok(view.includes(literal), `BillingView keeps the ${literal} endpoint literal visible`);
}

assert.match(view, /queryKey: \['billing', 'finalizations', from, to, detailState\.clientId\]/);
assert.match(view, /queryKey: \['billing', 'credit-notes', detailState\.clientId, activeFinalizationId\]/);
assert.match(view, /type BillingFinalizeIntent = \{[\s\S]*?clientId:[\s\S]*?dateFrom:[\s\S]*?dateTo:/);
assert.match(view, /const intent = billingFinalizeIntent[\s\S]*?clientId: intent\.clientId[\s\S]*?dateFrom: intent\.dateFrom[\s\S]*?dateTo: intent\.dateTo/);
assert.match(view, /billingFinalizationStatusLoading[\s\S]*?billingFinalizationStatusError[\s\S]*?billingFinalizations\.length > 0/);
assert.match(view, /readOnlyReason=\{billingPeriodReadOnlyReason\}/);
assert.match(view, /idempotencyKey: draft\.idempotencyKey/);

assert.match(panel, /selectedFinalization\.subtotal/);
assert.match(panel, /selectedFinalization\.creditedAmount/);
assert.match(panel, /selectedFinalization\.balance/);
assert.match(panel, /creditNotes\.map/);
assert.match(panel, /Invoice lines are immutable/);
assert.match(panel, /append-only current-period credit or debit adjustments/);
assert.match(panel, /adjustmentKind: 'credit' \| 'debit'/);
assert.match(panel, /<option value="credit">Credit<\/option>/);
assert.match(panel, /<option value="debit">Debit<\/option>/);
assert.match(panel, /current period \{note\.effectiveDate/);
assert.match(panel, /setIdempotencyKey\(requestKey\(\)\)/);
assert.doesNotMatch(panel, /subtotal\s*[-+]\s*creditedAmount|creditedAmount\s*[-+]\s*subtotal/);

assert.match(detailTable, /disabled=\{Boolean\(readOnlyReason\)\}/);
assert.match(lineHeader, /disabled=\{loading \|\| Boolean\(readOnlyReason\)\}/);

assert.match(policy, /export async function finalizeBillingPeriod/);
assert.match(policy, /billingInvoiceHeaderTotals/);
assert.match(policy, /export async function createBillingCreditNote/);
assert.match(policy, /export async function reconcileFinalizedBillingOrderAdjustments/);
assert.match(policy, /BILLING_CREDIT_EXCEEDS_BALANCE/);
assert.match(route, /'\/finalize'[\s\S]*?financials:write/);
assert.match(route, /'\/credit-notes'[\s\S]*?financials:write/);

assert.match(browserSpec, /Finalize and lock/);
assert.match(browserSpec, /toHaveAttribute\('data-billing-period-locked', 'true'\)/);
assert.match(browserSpec, /toBeDisabled\(\)/);
assert.match(browserSpec, /Carrier service refund/);

for (const field of [
  'Business rule/workflow being changed',
  'Canonical backend/domain/read-model/policy owner',
  'Current duplicated/unsafe owners',
  'Where bad/stale/incomplete data can enter',
  'Callers that must delegate to the owner',
  'Wrapper/resolver/helper logic to delete or explicitly forbid',
  'Frontend role: display/action only; no authoritative business logic',
  'Backend boundary tests required',
  'Workflow/UI proof required',
]) {
  assert.ok(placement.includes(field), `placement record includes ${field}`);
}

assert.equal(
  packageJson.scripts?.['test:audit-billing-close-workflow-ux'],
  'tsx scripts/audit-billing-close-workflow-ux-guard.ts',
);
assert.equal(
  packageJson.scripts?.['test:audit-billing-close-workflow-ux:browser'],
  'playwright test web/e2e/billing-close-workflow.spec.js --reporter=line',
);
assert.match(sotPack, /'test:audit-billing-close-workflow-ux'/);
assert.match(
  audit,
  /- \[x\] 5\.7 \*\*Billing close workflow UX complete\*\*/,
  'canonical audit checklist marks 5.7 complete',
);

console.log('PASS Audit 5.7 billing close workflow UX guard');
