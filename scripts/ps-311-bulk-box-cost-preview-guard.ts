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
  /conn\.transaction\(/.test(svc));
check('apply ensures the real schema ONLY on the production singleton (a test conn never touches it)',
  /if \(conn === db\) \{[\s\S]*ensureBillingFinalizationPolicySchema\(\)[\s\S]*ensureBillingBoxResolutionsSchema\(\)/.test(svc));
check('apply route exists, regenerates the scope, and AUDITS the bulk money action',
  /\/box-cost\/bulk\/apply/.test(billingRoute) &&
  /applyBulkBoxCostResolutions\(/.test(billingRoute) &&
  /generateLineItems\(/.test(billingRoute) &&
  /action: 'bulk_box_cost_apply'/.test(billingRoute));
check('apply route is permission-gated (financials:write)',
  /box-cost\/bulk\/apply[\s\S]{0,90}requirePermission\('financials:write'\)/.test(billingRoute));

// ── PS-311 DATE FIX: the bulk preview + apply must normalize the operator's selected day range
// through the canonical billing calendar-day owner (billingDayRange / PS-208) so the LAST selected
// day is INCLUDED — like /generate and /invoice. Pre-fix the routes passed the raw inclusive
// "YYYY-MM-DD" dateTo straight to the service, whose lt(shipDate, dateTo) then silently dropped
// every order shipped on that last day (a "Jan 1 → Jan 5" apply only re-priced Jan 1–4).
check('PS-311: bulk preview + apply normalize the date range via billingDayRange (last selected day included, no off-by-one)',
  /function normalizeBulkBoxCostRange[\s\S]{0,160}billingDayRange\(/.test(billingRoute) &&
  /bulkBoxCostScopeSchema[\s\S]{0,160}\.transform\(normalizeBulkBoxCostRange\)/.test(billingRoute) &&
  /bulkBoxCostApplySchema[\s\S]{0,200}\.transform\(normalizeBulkBoxCostRange\)/.test(billingRoute));

// ── Slice 3: operator UI (BillingView box-review action → preview-first bulk modal) ──
const modal = readFileSync('web/src/components/Views/BulkBoxCostModal.tsx', 'utf8');
check('UI modal previews THEN applies via the two backend routes',
  /\/billing\/box-cost\/bulk\/preview/.test(modal) && /\/billing\/box-cost\/bulk\/apply/.test(modal));
check('UI Apply is GATED (needs a fetched preview + a confirm tick + a non-empty editable set)',
  /applyDisabled\s*=/.test(modal) && /!confirmed/.test(modal) && /editableOrderCount === 0/.test(modal));
const billingView = readFileSync('web/src/components/Views/BillingView.tsx', 'utf8');
// The Billing modal/layout extraction (d9942d62) split the wiring across three files:
// BillingView owns the open-state + threads the callbacks; BillingEditDetailModal renders
// the trigger buttons; BillingDetailModalStack mounts the modals. The guard follows the
// full chain across all three so it proves the wiring survived the extraction intact.
const editModal = readFileSync('web/src/components/Views/BillingEditDetailModal.tsx', 'utf8');
const modalStack = readFileSync('web/src/components/Views/BillingDetailModalStack.tsx', 'utf8');
check('bulk modal wired end-to-end (trigger → BillingView state → mounted modal)',
  // trigger button in the edit modal opens the bulk flow
  /data-bulk-box-cost-trigger/.test(editModal) && /onClick=\{onOpenBulkBoxCost\}/.test(editModal) &&
  // BillingView owns the open-state and threads the open callback + the state down
  /const \[bulkBoxCostOpen, setBulkBoxCostOpen\] = useState/.test(billingView) &&
  /onOpenBulkBoxCost=\{\(\) => setBulkBoxCostOpen\(true\)\}/.test(billingView) &&
  /bulkBoxCostOpen=\{bulkBoxCostOpen\}/.test(billingView) &&
  // the modal is imported + mounted in the detail modal stack
  /import BulkBoxCostModal/.test(modalStack) && /<BulkBoxCostModal/.test(modalStack));

// ── PS-311b: the NEEDS-REVIEW dims-based sweep (companion to the packageId-based bulk). It matches
// unmatched orders by their package_cost_missing review-line description (the dims signature) — the
// only way to reach the still-unmatched siblings the packageId path cannot see — and writes the same
// PS-207 override resolution. Same server-side scope + money-safety posture as the bulk path.
const byDimsSvc = readFileSync('src/services/billing-box-cost-by-dims.ts', 'utf8');
check('by-dims: matches needs-review orders by client + review-line description (the dims signature) + [dateFrom, dateTo) ship-date',
  /eq\(billingLineItems\.clientId, scope\.clientId\)/.test(byDimsSvc) &&
  /eq\(billingLineItems\.lineType, REVIEW_LINE_TYPE\)/.test(byDimsSvc) &&
  /eq\(billingLineItems\.description, signature\)/.test(byDimsSvc) &&
  /gte\(billingLineItems\.shipDate, new Date\(scope\.dateFrom\)\)/.test(byDimsSvc) &&
  /lt\(billingLineItems\.shipDate, new Date\(scope\.dateTo\)\)/.test(byDimsSvc));
check('by-dims: re-derives the box signature SERVER-SIDE from the source order (never trusts an FE dims string)',
  /fetchBoxReviewSignature\(/.test(byDimsSvc) && /sourceOrderId/.test(byDimsSvc));
check('by-dims: writes ONLY billing_box_resolutions by upsert; NEVER client_package_prices',
  /\.insert\(billingBoxResolutions\)/.test(byDimsSvc) && /onConflictDoUpdate/.test(byDimsSvc) && !/clientPackagePrices/.test(byDimsSvc));
check('by-dims: ONE transaction, finalized orders skipped, schema ensured only on the prod singleton',
  /conn\.transaction\(/.test(byDimsSvc) &&
  /splitBulkBoxCostApplyTargets\(/.test(byDimsSvc) &&
  /if \(conn === db\) \{[\s\S]*ensureBillingFinalizationPolicySchema\(\)[\s\S]*ensureBillingBoxResolutionsSchema\(\)/.test(byDimsSvc));
check('by-dims routes (preview/apply/revert) exist, are financials:write gated, regenerate, and audit the money action',
  /\/box-cost\/by-dims\/preview/.test(billingRoute) &&
  /\/box-cost\/by-dims\/apply/.test(billingRoute) &&
  /\/box-cost\/by-dims\/revert/.test(billingRoute) &&
  /previewBulkBoxCostByDims\(/.test(billingRoute) &&
  /applyBulkBoxCostByDimsResolutions\(/.test(billingRoute) &&
  /action: 'bulk_box_cost_by_dims_apply'/.test(billingRoute) &&
  /box-cost\/by-dims\/apply[\s\S]{0,90}requirePermission\('financials:write'\)/.test(billingRoute));
check('by-dims routes normalize the date range via billingDayRange (last selected day included)',
  /byDimsScopeSchema[\s\S]{0,160}\.transform\(normalizeBulkBoxCostRange\)/.test(billingRoute) &&
  /byDimsRevertSchema[\s\S]{0,200}\.transform\(normalizeBulkBoxCostRange\)/.test(billingRoute));

// ── PS-311b UNDO: apply stamps a deterministic [box-sweep] marker note; revert re-derives it
// server-side from the source order and deletes ONLY marker-stamped resolutions (manual edits safe).
check('by-dims apply stamps the [box-sweep] marker note (so the sweep is always reversible)',
  /SWEEP_NOTE_PREFIX/.test(byDimsSvc) && /const note = sweepNote\(signature\)/.test(byDimsSvc));
check('by-dims revert re-derives the marker from the source order and deletes ONLY marker-noted resolutions',
  /revertBulkBoxCostByDimsResolutions/.test(byDimsSvc) &&
  /fetchSweepNoteForOrder\(/.test(byDimsSvc) &&
  /\.delete\(billingBoxResolutions\)/.test(byDimsSvc) &&
  /eq\(billingBoxResolutions\.note, note\)/.test(byDimsSvc));
check('by-dims revert route exists, is financials:write gated, regenerates, and audits the undo',
  /box-cost\/by-dims\/revert[\s\S]{0,90}requirePermission\('financials:write'\)/.test(billingRoute) &&
  /revertBulkBoxCostByDimsResolutions\(/.test(billingRoute) &&
  /action: 'bulk_box_cost_by_dims_revert'/.test(billingRoute));
// PS-311b review fix #1 (HIGH): UNDO must SKIP orders invoiced after the sweep — never strip a box
// cost off a finalized invoice (mirrors the apply-side finalized skip).
check('by-dims revert has an invoiced/finalized guard (never reverts an invoiced order)',
  /bool_or\(coalesce\(\$\{billingLineItems\.invoiced\}/.test(byDimsSvc) &&
  /\.filter\(\(r\) => r\.invoiced !== true\)/.test(byDimsSvc) &&
  /skippedFinalizedCount/.test(byDimsSvc));
// PS-311b review fix #2 (MEDIUM): the box-cost bulk/by-dims queries select FROM billing_line_items
// WITHOUT joining `clients`, so they must use the billing_line_items-keyed scope predicate — the
// clients-rooted one 500s ("missing FROM-clause entry for clients") for any restricted caller.
const lineItemScopeFn = /function billingLineItemClientScopePredicate\(scope: ClientStoreScope\): SQL \{[\s\S]*?\n\}/.exec(billingRoute)?.[0] ?? '';
check('box-cost bulk + by-dims routes use the clients-less billingLineItemClientScopePredicate (no 500 for scoped callers)',
  lineItemScopeFn.includes('billingLineItems.clientId') &&
  lineItemScopeFn.includes('exists (') &&
  !/\bbillingClientScopePredicate\(scope\),/.test(billingRoute));

// ── PS-311b: the operator UI — a date-range picker ON the modal, reachable from the needs-review row.
const sweepModal = readFileSync('web/src/components/Views/BoxReviewSweepModal.tsx', 'utf8');
check('sweep modal has a START + END date picker and previews THEN applies via the by-dims routes',
  /data-box-review-sweep-from/.test(sweepModal) &&
  /data-box-review-sweep-to/.test(sweepModal) &&
  /\/billing\/box-cost\/by-dims\/preview/.test(sweepModal) &&
  /\/billing\/box-cost\/by-dims\/apply/.test(sweepModal));
check('sweep modal Apply is GATED (preview fetched + confirm tick + non-empty editable set + valid range)',
  /applyDisabled\s*=/.test(sweepModal) && /!confirmed/.test(sweepModal) && /editableOrderCount === 0/.test(sweepModal) && /!rangeValid/.test(sweepModal));
check('sweep modal offers UNDO after apply (one-click revert via the by-dims/revert route)',
  /data-box-review-sweep-undo/.test(sweepModal) && /\/billing\/box-cost\/by-dims\/revert/.test(sweepModal));
check('sweep modal wired end-to-end (needs-review trigger → BillingView state → mounted modal)',
  // trigger button in the edit modal opens the sweep (no package pick required)
  /data-box-review-sweep-trigger/.test(editModal) && /onClick=\{onOpenBoxReviewSweep\}/.test(editModal) &&
  // BillingView owns the open-state and threads the open callback + the state down
  /const \[boxReviewSweepOpen, setBoxReviewSweepOpen\] = useState/.test(billingView) &&
  /onOpenBoxReviewSweep=\{\(\) => setBoxReviewSweepOpen\(true\)\}/.test(billingView) &&
  /boxReviewSweepOpen=\{boxReviewSweepOpen\}/.test(billingView) &&
  // the modal is imported + mounted in the detail modal stack
  /import BoxReviewSweepModal/.test(modalStack) && /<BoxReviewSweepModal/.test(modalStack));

if (failures > 0) {
  console.error(`\nPS-311 bulk box-cost preview guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-311 bulk box-cost preview guard passed.');
