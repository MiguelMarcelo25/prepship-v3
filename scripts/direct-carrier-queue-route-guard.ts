import assert from 'node:assert/strict';
import { classifyQueueOrderRoute } from '../web/src/components/Views/orders-parity';

// Send-to-Queue routing: a direct-carrier order that still needs a label is the
// ONLY case the Render queue job (ShipStation-only createLabelV2) can't handle,
// so it must be routed to the Vercel direct-label create+queue path. Everything
// else stays on the backend job. Buying real postage is gated to exactly this
// case — never for test orders or test-mode runs.

const DIRECT_NO_LABEL = { hasQueueableLabel: false, isTest: false, isDirectCarrier: true };

// The one case that buys via the Vercel path:
assert.equal(classifyQueueOrderRoute(DIRECT_NO_LABEL), 'direct-create',
  'direct carrier, no label, real order -> Vercel direct create+queue');

// Everything that must NOT auto-buy here (stays on the backend job/mock):
assert.equal(
  classifyQueueOrderRoute({ hasQueueableLabel: true, isTest: false, isDirectCarrier: true }),
  'backend',
  'direct carrier that ALREADY has a queueable label -> backend queues it as-is',
);
assert.equal(
  classifyQueueOrderRoute({ hasQueueableLabel: false, isTest: true, isDirectCarrier: true }),
  'backend',
  'test-client order never buys real postage -> backend mock',
);
assert.equal(
  classifyQueueOrderRoute(DIRECT_NO_LABEL, { batchTestMode: true }),
  'backend',
  'test-mode run never buys real postage -> backend mock',
);
assert.equal(
  classifyQueueOrderRoute(DIRECT_NO_LABEL, { existingLabelOnly: true }),
  'backend',
  'existing-label-only callers never create a label',
);

// ShipStation (non-direct) providers always stay on the backend job:
assert.equal(
  classifyQueueOrderRoute({ hasQueueableLabel: false, isTest: false, isDirectCarrier: false }),
  'backend',
  'ShipStation provider -> backend createLabelV2',
);

console.log('PASS direct-carrier queue route guard');
