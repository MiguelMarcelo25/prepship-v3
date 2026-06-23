/**
 * PS-perf — REAL EXECUTION test for the interactive-priority rate limiter (QA audit 2026-06-23).
 *
 * Proves the concurrency contract of runWithGlobalRateLimiter:
 *   1. an INTERACTIVE fetch that queues AFTER background fetches still runs BEFORE them when a
 *      permit frees (the priority lane — the user's Browse Rates click jumps the queue), and
 *   2. nothing deadlocks — every queued operation completes and the active count drains to 0.
 *
 * Pure + deterministic (no DB / network — the operations are gate-controlled promises; with only a
 * handful of ops the ShipStation budget never throttles, so the permit queue is the gating factor).
 * Run: npm run test:ps-rate-limiter-priority-behavior
 */
import { runWithGlobalRateLimiter, RATE_FETCH_CONCURRENCY } from '../src/services/rates';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function main() {
  const log: string[] = [];

  // 1. Saturate every permit with background "holders" that block on a per-holder gate.
  const releases: Array<() => void> = [];
  const holders: Array<Promise<void>> = [];
  for (let i = 0; i < RATE_FETCH_CONCURRENCY; i += 1) {
    const gate = new Promise<void>((resolve) => releases.push(resolve));
    holders.push(runWithGlobalRateLimiter(async () => { await gate; }, 'background'));
  }
  await tick();

  // 2. Queue two BACKGROUND ops first, then one INTERACTIVE op LAST. All must wait (no free permit).
  const bgA = runWithGlobalRateLimiter(async () => { log.push('bgA'); }, 'background');
  const bgB = runWithGlobalRateLimiter(async () => { log.push('bgB'); }, 'background');
  const interactive = runWithGlobalRateLimiter(async () => { log.push('interactive'); }, 'interactive');
  await tick();
  check('all permits held — no queued op has run yet', log.length === 0, log);

  // 3. Free exactly ONE permit. The freed permit must wake the INTERACTIVE waiter first, even
  //    though it queued AFTER both background ops.
  releases[0]();
  await tick();
  await tick();
  check('interactive runs first when a permit frees (priority lane)', log[0] === 'interactive', log);

  // 4. Free the rest — everything drains, nothing deadlocks.
  for (let i = 1; i < releases.length; i += 1) releases[i]();
  await Promise.all([...holders, bgA, bgB, interactive]);
  check('every queued op completed (no deadlock)',
    log.includes('interactive') && log.includes('bgA') && log.includes('bgB'), log);
  check('interactive was strictly before both background ops',
    log.indexOf('interactive') < log.indexOf('bgA') && log.indexOf('interactive') < log.indexOf('bgB'), log);

  // 5. The limiter is reusable after draining (active count returned to 0 → a fresh op runs immediately).
  let ran = false;
  await runWithGlobalRateLimiter(async () => { ran = true; }, 'interactive');
  check('limiter is reusable after drain (active count reset)', ran === true);

  if (failures > 0) {
    console.error(`\nPS rate-limiter priority behavior test FAILED with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nPS rate-limiter priority behavior test passed.');
}

void main();
