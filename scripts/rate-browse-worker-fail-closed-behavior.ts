import assert from 'node:assert/strict';
import { armRateBrowseWorkerHardDeadline } from '../src/services/rate-browse-worker.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let terminated = 0;
const disarmExpired = armRateBrowseWorkerHardDeadline({
  jobId: 'stalled-rate-job',
  generation: 2,
  timeoutMs: 10,
  graceMs: 5,
  terminate: () => { terminated += 1; },
});
await delay(30);
disarmExpired();
assert.equal(terminated, 1, 'a wedged rate browse generation must trigger fail-closed worker recovery');

let canceledTermination = 0;
const disarmCompleted = armRateBrowseWorkerHardDeadline({
  jobId: 'completed-rate-job',
  generation: 1,
  timeoutMs: 20,
  graceMs: 5,
  terminate: () => { canceledTermination += 1; },
});
disarmCompleted();
await delay(35);
assert.equal(canceledTermination, 0, 'a completed generation must disarm the hard deadline');

console.log('PASS Rate Browser worker fail-closed deadline behavior');
