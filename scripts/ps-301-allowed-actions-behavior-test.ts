/**
 * PS-301 — REAL EXECUTION test for the named action policy (verbs + blockedReasons).
 *
 * This is the part of the named contract that GATES the row's action buttons. The regex guard
 * checks shape; this test EXECUTES deriveOrderRowNamedActions + deriveOrderRowBlockedReasons and
 * asserts: the awaiting-only verbs (canEditPackage / canSelectRow) that REINFORCE the
 * shipped/cancelled lock, that createLabel/printToQueue stay exactly as narrow as the PS-173
 * base, and the machine-readable reason chosen for each disabled verb. A regression (e.g. a
 * shipped row reporting canSelectRow, or a disabled createLabel losing its reason) would pass
 * the regex guard but fail here.
 *
 * Pure + deterministic (no I/O). Run: npm run test:ps-301-allowed-actions-behavior
 */
import {
  deriveOrderRowNamedActions,
  deriveOrderRowBlockedReasons,
} from '../src/services/shipping-workflow/order-row-allowed-actions';
import type { BestRateWorkflowAllowedActions } from '../src/services/shipping-workflow/best-rate-workflow-dto';
import type { OrderRowActionVerb } from '../src/services/shipping-workflow/order-row-states';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const baseActions = (over: Partial<BestRateWorkflowAllowedActions> = {}): BestRateWorkflowAllowedActions =>
  ({ canUseSavedRate: false, canCreateLabel: false, ...over });

const ALL_VERBS: OrderRowActionVerb[] = ['browseRates', 'recalculate', 'applyBestRate', 'createLabel', 'printToQueue', 'markExternalShipped', 'editPackage', 'selectRow'];
const verbs = (over: Partial<Record<OrderRowActionVerb, boolean>> = {}): Record<OrderRowActionVerb, boolean> => {
  const r = {} as Record<OrderRowActionVerb, boolean>;
  ALL_VERBS.forEach((v) => { r[v] = false; });
  return { ...r, ...over };
};

// 1. Named verbs — final rate gates apply; queue tracks the PS-173 base; edit/select are awaiting-only.
const full = deriveOrderRowNamedActions('final', 'awaiting', baseActions({ canQueueLabel: true }));
check('named: final + awaiting + base.canQueueLabel → all four true',
  full.canApplyBestRate === true && full.canPrintToQueue === true && full.canEditPackage === true && full.canSelectRow === true);
check('named: non-final rowState → canApplyBestRate false',
  deriveOrderRowNamedActions('pending', 'awaiting', baseActions({ canQueueLabel: true })).canApplyBestRate === false);
check('named: canPrintToQueue mirrors base.canQueueLabel (no widening)',
  deriveOrderRowNamedActions('final', 'awaiting', baseActions({ canQueueLabel: false })).canPrintToQueue === false);
// Awaiting-only edit/select REINFORCE the shipped/cancelled lock.
const shipped = deriveOrderRowNamedActions('final', 'shipped', baseActions({ canQueueLabel: true }));
check('named: shipped row → canEditPackage + canSelectRow false (lockdown)',
  shipped.canEditPackage === false && shipped.canSelectRow === false);
const cancelled = deriveOrderRowNamedActions('final', 'cancelled', baseActions({ canQueueLabel: true }));
check('named: cancelled row → canEditPackage + canSelectRow false (lockdown)',
  cancelled.canEditPackage === false && cancelled.canSelectRow === false);

// 2. Blocked reasons — lifecycle locks dominate every disabled verb.
const cancelledReasons = deriveOrderRowBlockedReasons(verbs(), { lifecycle: 'cancelled', rateState: 'final', labelState: 'none' });
check('reasons: cancelled lifecycle → cancelled_lock for every disabled verb',
  ALL_VERBS.every((v) => cancelledReasons[v] === 'cancelled_lock'));
check('reasons: external_shipped → external_shipped',
  deriveOrderRowBlockedReasons(verbs(), { lifecycle: 'external_shipped', rateState: 'final', labelState: 'none' }).createLabel === 'external_shipped');
check('reasons: shipped → shipped_lock',
  deriveOrderRowBlockedReasons(verbs(), { lifecycle: 'shipped', rateState: 'final', labelState: 'none' }).createLabel === 'shipped_lock');

// 3. Blocked reasons — rate-bearing verbs (awaiting), most specific cause wins.
check('reasons: applyBestRate disabled with a final rate → rate_not_final',
  deriveOrderRowBlockedReasons(verbs(), { lifecycle: 'awaiting', rateState: 'final', labelState: 'none' }).applyBestRate === 'rate_not_final');
check('reasons: createLabel + missing_dims → missing_dims',
  deriveOrderRowBlockedReasons(verbs(), { lifecycle: 'awaiting', rateState: 'missing_dims', labelState: 'none' }).createLabel === 'missing_dims');
check('reasons: createLabel + unavailable rate → no_rate',
  deriveOrderRowBlockedReasons(verbs(), { lifecycle: 'awaiting', rateState: 'unavailable', labelState: 'none' }).createLabel === 'no_rate');
check('reasons: printToQueue + already-queued label → already_queued',
  deriveOrderRowBlockedReasons(verbs(), { lifecycle: 'awaiting', rateState: 'final', labelState: 'queued' }).printToQueue === 'already_queued');
check('reasons: createLabel + active label → existing_active_label',
  deriveOrderRowBlockedReasons(verbs(), { lifecycle: 'awaiting', rateState: 'final', labelState: 'active_label' }).createLabel === 'existing_active_label');

// 4. Blocked reasons — non-rate verbs + the only-disabled-verbs-get-a-reason invariant.
const oneTrue = deriveOrderRowBlockedReasons(verbs({ createLabel: true }), { lifecycle: 'awaiting', rateState: 'missing_dims', labelState: 'none' });
check('reasons: an ALLOWED verb gets NO reason key', oneTrue.createLabel === undefined);
check('reasons: non-rate verb + missing_dims → missing_dims', oneTrue.selectRow === 'missing_dims');
check('reasons: non-rate verb + otherwise → needs_current_rate',
  deriveOrderRowBlockedReasons(verbs(), { lifecycle: 'awaiting', rateState: 'final', labelState: 'none' }).selectRow === 'needs_current_rate');

if (failures > 0) {
  console.error(`\nPS-301 allowed-actions behavior test FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-301 allowed-actions behavior test passed.');
