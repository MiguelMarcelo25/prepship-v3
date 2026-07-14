/**
 * PS-296 (FE) guard — BillingView consumes the backend carrier/account margin breakdown.
 *
 * The PS-296 audit found the carrier rollup (analytics.carriers[]) was FETCHED but
 * DISCARDED — BillingView only kept .summary. This guard pins the first consumer: the
 * "Margin by carrier / account" breakdown table, stored from marginAnalytics.carriers and
 * rendered read-only from the backend fields (no FE recompute). Fails if the consumption
 * is removed.
 *
 * Offline/static only.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}
function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

const billing = read('web/src/components/Views/BillingView.tsx');

check('BillingView types the carrier breakdown row', /type ShippingMarginCarrierDto = \{/.test(billing));
// FE-2 (audit 2.2 slice 2, 2026-07-14): BillingView's margin analytics moved onto
// React Query (['billing','shipping-margin', ...]) — the carriers rollup is now
// read via a typed derived const instead of a useState setter, same as the
// DashboardView re-pin below. Same invariants re-pinned: the backend
// analytics.carriers[] is stored (not discarded) and a no-data/error render
// falls back to the module-level EMPTY const instead of a setter reset.
check('BillingView holds carrier breakdown state (query-derived)',
  /const shippingMarginCarriers: ShippingMarginCarrierDto\[\] = shippingMarginQuery\.data\?\.carriers \?\? EMPTY_SHIPPING_MARGIN_CARRIERS/.test(billing));
check('BillingView stores the backend analytics.carriers[] (was discarded)',
  /shippingMarginQuery\.data\?\.carriers \?\? EMPTY_SHIPPING_MARGIN_CARRIERS/.test(billing));
check('BillingView resets carriers on error (EMPTY fallback const)',
  /const EMPTY_SHIPPING_MARGIN_CARRIERS: ShippingMarginCarrierDto\[\] = \[\]/.test(billing));
// PS-296 restyle: the carrier breakdown table moved onto the shared <Table> (with pagination) in
// BillingCarrierMarginTable.tsx. BillingView still owns the state/storage above and now WIRES the
// component from the stored carriers; the rendering + backend-field reads live in the new component.
check('BillingView wires the carrier breakdown table (BillingCarrierMarginTable) from the stored carriers',
  /<BillingCarrierMarginTable carriers=\{shippingMarginCarriers\}/.test(billing));
const carrierTable = read('web/src/components/Views/BillingCarrierMarginTable.tsx');
check('the carrier breakdown table renders "Margin by carrier / account" and iterates the carriers',
  /Margin by carrier \/ account/.test(carrierTable) &&
  /carriers\.map\(/.test(carrierTable));
check('the table reads backend margin fields (no FE recompute)',
  /row\.marginTotal/.test(carrierTable) &&
  /row\.negativeMarginCount/.test(carrierTable) &&
  /row\.marginPct/.test(carrierTable));

// PS-296 req6: per-order reconciliation drilldown (analytics.rows[], also discarded before).
// Repointed (guard rot): the drilldown table was EXTRACTED from BillingView into
// BillingShippingMarginReconciliation.tsx. BillingView keeps the row type via the import alias,
// still stores the backend rows, and now WIRES the component from that stored state; the
// rendering + backend-field reads live in the extracted component.
// FE-2 (audit 2.2 slice 2, 2026-07-14): same React Query re-pin as the carriers
// above — the reconciliation rows are a derived const off the shipping-margin
// query (cast kept so the extracted component's row type still governs).
check('BillingView stores the backend analytics.rows[] (per-shipment reconciliation)',
  /type BillingShippingMarginReconciliationRow as ShippingMarginRowDto/.test(billing) &&
  /const shippingMarginRows = \(shippingMarginQuery\.data\?\.rows \?\? EMPTY_SHIPPING_MARGIN_ROWS\) as ShippingMarginRowDto\[\]/.test(billing));
const reconciliation = read('web/src/components/Views/BillingShippingMarginReconciliation.tsx');
check('the extracted drilldown component renders the per-order table from backend fields, wired from BillingView',
  /Per-order reconciliation/.test(reconciliation) &&
  /rows\.slice\(0, limit\)\.map\(/.test(reconciliation) &&
  /row\.marginAmount/.test(reconciliation) &&
  /row\.missingProofReasons/.test(reconciliation) &&
  /<BillingShippingMarginReconciliation\s*\r?\n?\s*rows=\{shippingMarginRows\}/.test(billing));
check('drilldown caps with a VISIBLE "showing X of N" note (no silent truncation)',
  /Showing first \{limit\} of \{rows\.length\}/.test(reconciliation));

// Dashboard consumes the same backend carrier rollup (was also discarded — only .summary kept).
const dashboard = read('web/src/components/Views/DashboardView.tsx');
// FE-2 (audit 2.2 slice 1): the carriers rollup now travels through the
// shipping-margin React Query cache — normalized in the queryFn, read via a
// derived const — instead of a useState setter. Same invariant: the backend
// carriers[] is normalized and kept, not discarded.
check('DashboardView normalizes + stores the backend analytics.carriers[]',
  /function normalizeShippingMarginCarriers/.test(dashboard) &&
  /carriers: normalizeShippingMarginCarriers\(shippingMarginRes\?\.carriers\)/.test(dashboard) &&
  /const shippingMarginCarriers = shippingMarginQuery\.data\?\.carriers \?\? EMPTY_SHIPPING_MARGIN_CARRIERS/.test(dashboard));
// PS-296 restyle (dashboard): the dashboard carrier breakdown moved onto the SAME shared
// <Table>-based component as Billing (BillingCarrierMarginTable) so it pages instead of rendering
// every carrier inline. DashboardView still owns the normalize+store above and now WIRES the
// component from the stored carriers. The "reads backend fields, no FE recompute" invariant is
// pinned by the carrierTable checks above (row.marginTotal / row.negativeMarginCount / row.marginPct),
// which now govern BOTH views since they share one component. The distinct storageKey keeps the
// dashboard's page/sort state independent of the Billing table (non-vacuous: a copy-paste of the
// Billing wiring would not match it).
check('DashboardView wires the carrier breakdown via the shared paginated BillingCarrierMarginTable (distinct storageKey)',
  /<BillingCarrierMarginTable\s+carriers=\{shippingMarginCarriers\}\s+storageKey="dashboard-carrier-margin"/.test(dashboard));

if (failures > 0) {
  console.error(`\nPS-296 FE carrier breakdown guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-296 FE carrier breakdown guard passed.');
