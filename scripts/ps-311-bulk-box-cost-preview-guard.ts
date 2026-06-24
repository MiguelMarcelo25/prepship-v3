/**
 * PS-311 (slice 1) — REAL execution test for the bulk box-cost PREVIEW (dry-run).
 *
 * Bulk-apply a reviewed box cost to every order in a (client + date range + box) scope. This
 * slice is READ-ONLY: it previews the affected orders + the before/after invoice impact, and
 * EXCLUDES finalized (invoiced) orders from the change. Drives the pure computeBulkBoxCostPreview
 * and pins the route wiring (re-derives scope server-side, permission-gated, no writes).
 * Offline/pure: no DB, no network, no shipped/cancelled mutation.
 */
import { readFileSync } from 'node:fs';
import { computeBulkBoxCostPreview, splitBulkBoxCostApplyTargets } from '../src/services/billing-box-cost-bulk';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// 3 editable orders (current box $1.00 / $1.00 / $0.00) + 2 FINALIZED (invoiced) ones that
// must be reported but excluded from the change.
const rows = [
  { orderId: 1, orderNumber: 'A1', currentBoxCost: 1.0, invoiced: false },
  { orderId: 2, orderNumber: 'A2', currentBoxCost: 1.0, invoiced: false },
  { orderId: 3, orderNumber: 'A3', currentBoxCost: 0.0, invoiced: false },
  { orderId: 4, orderNumber: 'B1', currentBoxCost: 5.0, invoiced: true },
  { orderId: 5, orderNumber: 'B2', currentBoxCost: 5.0, invoiced: true },
];
const p = computeBulkBoxCostPreview(rows, 2.5);

check('matched = every order in scope billed for the box', p.matchedOrderCount === 5);
check('finalized (invoiced) orders are reported', p.finalizedOrderCount === 2);
check('editable = the non-finalized orders that would change', p.editableOrderCount === 3);
check('beforeTotal sums ONLY editable current box costs (1+1+0)', p.beforeTotal === 2.0);
check('afterTotal = newCost × editable count (2.50 × 3)', p.afterTotal === 7.5);
check('delta = afterTotal − beforeTotal', p.delta === 5.5);
check('FINALIZED orders excluded from the money (their $5 each is NOT counted)',
  p.beforeTotal === 2.0 && p.afterTotal === 7.5);
check('sample order numbers come from editable orders only',
  p.sampleOrderNumbers.length === 3 && p.sampleOrderNumbers.every((n) => ['A1', 'A2', 'A3'].includes(n)));
check('newCost is rounded to 2dp', computeBulkBoxCostPreview([], 2.555).newCost === 2.56);
const empty = computeBulkBoxCostPreview([], 3);
check('empty scope → all zeros (no fabricated impact)',
  empty.matchedOrderCount === 0 && empty.editableOrderCount === 0 && empty.beforeTotal === 0 && empty.afterTotal === 0);
const allFinalized = computeBulkBoxCostPreview(
  [{ orderId: 9, orderNumber: 'Z', currentBoxCost: 4, invoiced: true }],
  2,
);
check('a scope of only finalized orders → 0 editable, 0 before/after (apply would be a no-op)',
  allFinalized.matchedOrderCount === 1 && allFinalized.editableOrderCount === 0 &&
  allFinalized.beforeTotal === 0 && allFinalized.afterTotal === 0);

// ── Route wiring: re-derives scope server-side, permission-gated, READ-ONLY (no writes) ──
const billingRoute = readFileSync('src/routes/billing.ts', 'utf8');
check('preview route exists + delegates to previewBulkBoxCost with the server-derived billing scope',
  /\/box-cost\/bulk\/preview/.test(billingRoute) &&
  /previewBulkBoxCost\(/.test(billingRoute) &&
  /billingClientScopePredicate\(scope\)/.test(billingRoute));
check('preview route is permission-gated (financials:write)',
  /box-cost\/bulk\/preview[\s\S]{0,90}requirePermission\('financials:write'\)/.test(billingRoute));

const svc = readFileSync('src/services/billing-box-cost-bulk.ts', 'utf8');

// Scope is enforced SERVER-SIDE (the card's DoD: "rows outside the range/client do not change",
// "backend must enforce the same scope; do not trust only frontend filters"). The fetch WHERE
// clause pins client + package + ship-date >= dateFrom + ship-date < dateTo, so an order outside
// any of those can never be matched, previewed, or re-priced.
check('scope enforced server-side: fetch filters by client + package + [dateFrom, dateTo) ship-date',
  /eq\(billingLineItems\.clientId, scope\.clientId\)/.test(svc) &&
  /eq\(billingLineItems\.packageId, scope\.packageId\)/.test(svc) &&
  /gte\(billingLineItems\.shipDate, new Date\(scope\.dateFrom\)\)/.test(svc) &&
  /lt\(billingLineItems\.shipDate, new Date\(scope\.dateTo\)\)/.test(svc));

// ── Slice 2: APPLY safety ──
const split = splitBulkBoxCostApplyTargets(rows);
check('apply: finalized (invoiced) orders are NEVER in the editable set (skipped, never re-billed)',
  split.editable.length === 3 &&
  split.skippedFinalized.length === 2 &&
  split.editable.every((r) => !r.invoiced) &&
  split.skippedFinalized.every((r) => r.invoiced));
check('apply service writes ONLY billing_box_resolutions, by upsert (the PS-207 directive)',
  /\.insert\(billingBoxResolutions\)/.test(svc) && /onConflictDoUpdate/.test(svc));
check('apply service NEVER writes client_package_prices (timeless table — card forbids re-pricing it)',
  !/clientPackagePrices/.test(svc));
check('apply runs in ONE transaction (all editable orders re-price, or none)',
  /db\.transaction\(/.test(svc));
check('apply route exists, regenerates the scope, and AUDITS the bulk money action',
  /\/box-cost\/bulk\/apply/.test(billingRoute) &&
  /applyBulkBoxCostResolutions\(/.test(billingRoute) &&
  /generateLineItems\(/.test(billingRoute) &&
  /action: 'bulk_box_cost_apply'/.test(billingRoute));
check('apply route is permission-gated (financials:write)',
  /box-cost\/bulk\/apply[\s\S]{0,90}requirePermission\('financials:write'\)/.test(billingRoute));

// ── Slice 3: operator UI (BillingView box-review action → preview-first bulk modal) ──
const modal = readFileSync('web/src/components/Views/BulkBoxCostModal.tsx', 'utf8');
check('UI modal previews THEN applies via the two backend routes',
  /\/billing\/box-cost\/bulk\/preview/.test(modal) && /\/billing\/box-cost\/bulk\/apply/.test(modal));
check('UI Apply is GATED (needs a fetched preview + a confirm tick + a non-empty editable set)',
  /applyDisabled\s*=/.test(modal) && /!confirmed/.test(modal) && /editableOrderCount === 0/.test(modal));
const billingView = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');
check('BillingView wires the bulk modal from the box-review action',
  /import BulkBoxCostModal/.test(billingView) &&
  /<BulkBoxCostModal/.test(billingView) &&
  /data-bulk-box-cost-trigger/.test(billingView));

if (failures > 0) {
  console.error(`\nPS-311 bulk box-cost preview guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-311 bulk box-cost preview guard passed.');
