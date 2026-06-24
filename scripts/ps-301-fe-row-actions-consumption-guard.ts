/**
 * PS-301 (FE consumption, slice 1) — REAL execution test for the frontend reader of the
 * backend row-workflow contract (web/src/components/Views/orders/order-row-actions.ts).
 *
 * Proves the FE can now CONSUME the backend verdict (named verbs + 5 state axes + per-verb
 * blockedReasons stamped on order.bestRateWorkflow) WITHOUT re-deriving it, and that the reader is
 * safe: an unenriched row reads `null` (caller falls back to legacy FE behavior, never fabricates),
 * and a shipped/cancelled row reports its awaiting-only verbs not-granted (reinforces the lock).
 * Pure/offline — no DB, no network, no OrdersView edit.
 */
import {
  getOrderRowAllowedActions,
  getOrderRowStateAxes,
  getOrderRowBlockedReasons,
  getOrderRowActionBlockedReason,
} from '../web/src/components/Views/orders/order-row-actions';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// A fully backend-enriched awaiting row (withOrderRowWorkflow output shape).
const enriched = {
  id: 1,
  bestRateWorkflow: {
    allowedActions: {
      canApplyBestRate: true,
      canPrintToQueue: false,
      canEditPackage: true,
      canSelectRow: true,
      canBrowseRates: true,
      canRecalculate: true,
      canQueueLabel: false,
      canMarkExternalShipped: false,
    },
    lifecycleState: 'awaiting',
    rateState: 'final',
    labelState: 'none',
    queueState: 'not_queued',
    packageState: 'resolved',
    blockedReasons: { printToQueue: 'no_rate', createLabel: 'missing_dims' },
  },
};

// A backend-enriched SHIPPED row: awaiting-only verbs are not granted; lock reasons present.
const shipped = {
  id: 2,
  bestRateWorkflow: {
    allowedActions: {
      canApplyBestRate: false,
      canPrintToQueue: true,
      canEditPackage: false,
      canSelectRow: false,
    },
    lifecycleState: 'shipped',
    blockedReasons: { selectRow: 'shipped_lock', editPackage: 'shipped_lock' },
  },
};

// A legacy / pre-deploy-cache row: no bestRateWorkflow at all.
const legacy = { id: 3, orderNumber: 'A3' };

// ── Enriched row: every verb + axis + reason is read from the backend ──
const a = getOrderRowAllowedActions(enriched);
check('enriched: PS-301 named verbs read from backend (apply=t, queue=f, editPkg=t, select=t)',
  a.canApplyBestRate === true && a.canPrintToQueue === false && a.canEditPackage === true && a.canSelectRow === true);
check('enriched: PS-173 base verbs read too (browse=t, recalc=t, queueLabel=f, markExt=f)',
  a.canBrowseRates === true && a.canRecalculate === true && a.canQueueLabel === false && a.canMarkExternalShipped === false);
const axes = getOrderRowStateAxes(enriched);
check('enriched: all 5 state axes read from backend',
  axes.lifecycleState === 'awaiting' && axes.rateState === 'final' && axes.labelState === 'none' &&
  axes.queueState === 'not_queued' && axes.packageState === 'resolved');
const reasons = getOrderRowBlockedReasons(enriched);
check('enriched: blockedReasons map read per-verb', reasons.printToQueue === 'no_rate' && reasons.createLabel === 'missing_dims');
check('enriched: blocked reason resolves to a human label',
  getOrderRowActionBlockedReason(enriched, 'printToQueue') === 'No rate is available for this order' &&
  getOrderRowActionBlockedReason(enriched, 'createLabel') === 'Add dimensions to rate this order');
check('enriched: a verb with NO blocked reason returns null', getOrderRowActionBlockedReason(enriched, 'applyBestRate') === null);

// ── Shipped row: lock is REINFORCED (awaiting-only verbs not granted) ──
const s = getOrderRowAllowedActions(shipped);
check('shipped: canSelectRow + canEditPackage are NOT granted (false) — lock reinforced',
  s.canSelectRow === false && s.canEditPackage === false);
check('shipped: lock reason surfaces for selectRow',
  getOrderRowActionBlockedReason(shipped, 'selectRow') === 'This order has shipped and is locked');

// ── Legacy row: every verb reads NULL so the caller keeps existing FE behavior (never fabricated) ──
const l = getOrderRowAllowedActions(legacy);
check('legacy (no backend enrichment): EVERY verb is null (fall back to legacy FE, never fabricate)',
  l.canApplyBestRate === null && l.canPrintToQueue === null && l.canEditPackage === null &&
  l.canSelectRow === null && l.canBrowseRates === null && l.canRecalculate === null &&
  l.canQueueLabel === null && l.canMarkExternalShipped === null);
check('legacy: state axes all null', Object.values(getOrderRowStateAxes(legacy)).every((v) => v === null));
check('legacy: blockedReasons empty + no reason', Object.keys(getOrderRowBlockedReasons(legacy)).length === 0 &&
  getOrderRowActionBlockedReason(legacy, 'selectRow') === null);
check('null (no order) is handled without throwing', getOrderRowAllowedActions(null).canSelectRow === null);

if (failures > 0) {
  console.error(`\nPS-301 FE row-actions consumption guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-301 FE row-actions consumption guard passed.');
