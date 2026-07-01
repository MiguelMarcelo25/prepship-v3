import assert from 'node:assert/strict';
import { classifyQueueOrderRouteServer } from '../src/services/print-queue/queue-route-orchestrator';

// Send-to-Queue routing is backend-owned. A direct-carrier order that still
// needs a label may classify as direct-create inside the pure backend owner,
// but PS-317/PS-359 live queue submission sends all orders through the backend
// create/recover/queue job.

const DIRECT_NO_LABEL = {
  hasQueueableLabel: false,
  isTest: false,
  isDirectCarrier: true,
  backendQueueRoute: null,
  explicitPayloadProviderId: null,
};

assert.equal(classifyQueueOrderRouteServer(DIRECT_NO_LABEL), 'direct-create',
  'backend owner: direct carrier, no label, real order -> direct-create classification');

assert.equal(
  classifyQueueOrderRouteServer({ ...DIRECT_NO_LABEL, hasQueueableLabel: true }),
  'backend',
  'direct carrier that already has a queueable label -> backend queues it as-is',
);
assert.equal(
  classifyQueueOrderRouteServer({ ...DIRECT_NO_LABEL, isTest: true }),
  'backend',
  'test-client order never buys real postage -> backend mock',
);
assert.equal(
  classifyQueueOrderRouteServer(DIRECT_NO_LABEL, { batchTestMode: true }),
  'backend',
  'test-mode run never buys real postage -> backend mock',
);
assert.equal(
  classifyQueueOrderRouteServer(DIRECT_NO_LABEL, { existingLabelOnly: true }),
  'backend',
  'existing-label-only callers never create a label',
);
assert.equal(
  classifyQueueOrderRouteServer(DIRECT_NO_LABEL, { directViaBackend: true }),
  'backend',
  'live queue submission can force residual direct carriers through backend orchestration',
);

assert.equal(
  classifyQueueOrderRouteServer({ ...DIRECT_NO_LABEL, isDirectCarrier: false }),
  'backend',
  'ShipStation provider -> backend createLabelV2',
);

console.log('PASS direct-carrier queue route guard');
