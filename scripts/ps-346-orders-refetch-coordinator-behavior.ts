import assert from 'node:assert/strict';
import { createOrdersRefetchCoordinator } from '../web/src/hooks/orders-refetch-coordinator';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function main() {
  const releases: Array<() => void> = [];
  let started = 0;
  let active = 0;
  let maxActive = 0;

  const coordinator = createOrdersRefetchCoordinator(async () => {
    started += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
  });

  const first = coordinator.request('initial-load');
  const second = coordinator.request('status-tick');
  const third = coordinator.request('settle-timer');

  await tick();
  assert.equal(started, 1, 'concurrent refetch requests must share the active /orders request');
  assert.equal(maxActive, 1, 'coordinator must not run overlapping /orders requests');

  releases.shift()?.();
  await tick();
  assert.equal(started, 2, 'requests arriving during an active refetch collapse into one trailing refresh');
  assert.equal(maxActive, 1, 'trailing refresh must wait for the active request to finish');

  releases.shift()?.();
  await Promise.all([first, second, third]);

  const fourth = coordinator.request('manual-refresh-after-idle');
  await tick();
  assert.equal(started, 3, 'a later idle request should still run normally');
  releases.shift()?.();
  await fourth;

  assert.equal(coordinator.getStats().inFlight, false, 'coordinator should return to idle');
  assert.equal(coordinator.getStats().queued, false, 'coordinator should clear queued state after the trailing refresh');

  console.log('PASS PS-346 orders refetch coordinator behavior');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
