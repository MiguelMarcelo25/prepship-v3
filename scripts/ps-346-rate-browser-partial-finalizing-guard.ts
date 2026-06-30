import assert from 'node:assert/strict';
import {
  RATE_BROWSER_BACKEND_PROOF_FINALIZING_REASON,
  RATE_BROWSER_BACKEND_PROOF_UNAVAILABLE_REASON,
  rateBrowserUnavailableReason,
} from '../web/src/lib/rate-browser-availability';
import {
  nextRateBrowserPendingPidsAfterPartial,
} from '../web/src/components/rate-browser-pending-state';

const pending = new Set([101, 102, 103, 104, 105, 106]);
const nextPending = nextRateBrowserPendingPidsAfterPartial({
  pendingPids: pending,
  ratesByPid: {
    '101': [{ amount: 7.69 }],
    '102': [],
  },
  statusByPid: {
    '102': 'cached',
    '103': 'unavailable',
    '104': 'error',
    '105': 'loading',
  },
});

assert.deepEqual(
  [...nextPending].sort((a, b) => a - b),
  [105, 106],
  'partial carrier statuses should clear terminal accounts from the pending/checking set',
);
assert.deepEqual(
  [...pending].sort((a, b) => a - b),
  [101, 102, 103, 104, 105, 106],
  'pending helper must not mutate the caller-owned Set',
);

const prooflessRate = { isComplete: false };
assert.equal(
  rateBrowserUnavailableReason(prooflessRate),
  RATE_BROWSER_BACKEND_PROOF_UNAVAILABLE_REASON,
  'proofless final rows should still ask the user to browse again',
);
assert.equal(
  rateBrowserUnavailableReason(prooflessRate, { proofFinalizing: true }),
  RATE_BROWSER_BACKEND_PROOF_FINALIZING_REASON,
  'proofless rows during an active live workflow should say backend proof is finalizing',
);
assert.equal(
  rateBrowserUnavailableReason({ isComplete: true }, { proofFinalizing: true }),
  null,
  'complete backend-proofed rows stay selectable even when a workflow flag is present',
);
assert.equal(
  rateBrowserUnavailableReason(
    {
      isComplete: true,
      eligibilityBlocked: true,
      eligibilityBlockReason: 'UPS Ground Saver is disabled for HUGRAB orders.',
    },
    { proofFinalizing: true },
  ),
  'UPS Ground Saver is disabled for HUGRAB orders.',
  'backend eligibility blocks must override proof-finalizing display copy',
);

console.log('PASS PS-346 rate browser partial finalizing guard');
