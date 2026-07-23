/**
 * PS-438 — backend-owned rate recalculation progress UI guard.
 *
 * Offline only: no database, provider, label, queue, or network calls.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildRecalculateAllProgressView,
  isManualRecalculateAllJob,
  type RecalculateAllProgressState,
} from '../web/src/components/Views/orders-recalculate-all-progress';

function view(state: RecalculateAllProgressState) {
  return buildRecalculateAllProgressView(state);
}

const starting = view({ job: null, preparingMessage: 'Preparing recalculation' });
assert.equal(starting.percent, null, 'starting progress must be indeterminate');
assert.equal(starting.total, null, 'starting progress must not invent a total');
assert.equal(starting.label, 'Preparing recalculation');

const backendPreparing = view({
  job: { jobId: 'backend-preparing', status: 'pending', processed: 0, total: 0 },
});
assert.equal(backendPreparing.percent, null, 'active backend total=0 remains indeterminate');
assert.equal(backendPreparing.total, null, 'active backend total=0 is not presented as a final zero total');

const partial = view({
  job: {
    jobId: 'partial',
    status: 'running',
    processed: 5,
    total: 20,
    updated: 2,
    failed: 1,
    skipped: 2,
    message: 'Rating awaiting orders',
  },
});
assert.equal(partial.percent, 25);
assert.equal(partial.completed, 5);
assert.equal(partial.remaining, 15);
assert.equal(partial.total, 20);
assert.equal(partial.updated, 2);
assert.equal(partial.failed, 1);
assert.equal(partial.skipped, 2);

const activeAtCount = view({
  job: { jobId: 'finalizing', status: 'running', processed: 20, total: 20 },
});
assert.equal(activeAtCount.percent, 99, 'an active job must never report 100%');

const complete = view({
  job: { jobId: 'complete', status: 'done', processed: 20, total: 20, updated: 19, failed: 1 },
});
assert.equal(complete.percent, 100);
assert.equal(complete.remaining, 0);
assert.equal(complete.tone, 'success');

const incompleteTerminal = view({
  job: { jobId: 'incomplete', status: 'done', processed: 18, total: 20 },
});
assert.equal(incompleteTerminal.percent, 90, 'an incomplete terminal snapshot must not show 100%');
assert.equal(incompleteTerminal.tone, 'error');
assert.match(incompleteTerminal.statusMessage, /Retry recalculation/);

const interrupted = view({
  job: { jobId: 'interrupted', status: 'error', processed: 3, total: 10, message: 'Carrier timeout' },
});
assert.match(interrupted.statusMessage, /Carrier timeout.*Retry recalculation/);

const unavailable = view({
  job: { jobId: 'unavailable', status: 'running', processed: 8, total: 20, updated: 7 },
  statusError: 'Status unavailable. Refresh to reattach, or retry recalculation.',
});
assert.equal(unavailable.completed, 8, 'status errors retain last known completed count');
assert.equal(unavailable.remaining, 12, 'status errors retain last known remaining count');
assert.equal(unavailable.percent, 40);
assert.equal(unavailable.tone, 'error');
assert.match(unavailable.statusMessage, /Refresh to reattach/);

assert.equal(
  isManualRecalculateAllJob({ jobId: 'manual', status: 'running', requestedBy: 'manual' }),
  true,
  'manual jobs may reattach visible progress',
);
for (const requestedBy of ['cadence', 'rate-on-ingest', 'targeted-order-change'] as const) {
  assert.equal(
    isManualRecalculateAllJob({ jobId: requestedBy, status: 'running', requestedBy }),
    false,
    `${requestedBy} jobs must not impersonate an operator click`,
  );
}

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const toolbar = readFileSync('web/src/components/Views/OrdersFilterToolbar.tsx', 'utf8');
const sharedProgress = readFileSync('web/src/components/Views/OrdersRecalculationProgress.tsx', 'utf8');
const helper = readFileSync('web/src/components/Views/orders-recalculate-all.ts', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> };

assert.match(ordersView, /setRecalcAllProgress\(\{ job \}\)/, 'poller retains the full backend job snapshot');
assert.match(ordersView, /isManualRecalculateAllJob\(job\)/, 'refresh reattachment is gated by backend request source');
assert.match(ordersView, /Status unavailable\. Refresh to reattach, or retry recalculation\./, 'unavailable state is actionable');
assert.match(toolbar, /OrdersRecalculationProgress[\s\S]*kind="all"/, 'Recalculate All uses shared progress UI');
assert.match(toolbar, /OrdersRecalculationProgress[\s\S]*kind="selected"/, 'Recalculate Selected uses shared progress UI');
assert.match(sharedProgress, /role="progressbar"/, 'shared progress exposes progressbar semantics');
assert.match(sharedProgress, /aria-valuenow=\{determinate \? percent : undefined\}/, 'indeterminate state omits aria-valuenow');
assert.match(sharedProgress, /Completed \{completed\.toLocaleString\(\)\}/, 'completed count is labelled');
assert.match(sharedProgress, /Remaining \{remainingLabel\}/, 'remaining count is labelled');
assert.match(helper, /generation\.requestedBy/, 'latest-job normalization carries backend request source');
assert.equal(
  packageJson.scripts?.['test:ps-438-rate-recalculation-progress'],
  'tsx scripts/ps-438-rate-recalculation-progress-guard.ts',
  'package exposes the PS-438 guard',
);

console.log('PASS PS-438 rate recalculation progress guard');
