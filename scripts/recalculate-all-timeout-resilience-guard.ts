/**
 * Recalculate All — per-order timeout RESILIENCE guard (Trello #750 "fix recalculate logic").
 *
 * THE BUG (confirmed from prod rate_backfill_best_rates.last_run failureSamples, 2026-06-18): a live
 * "Recalculate All" failed 37 of 43 orders, every sample "getRates(order=…) timed out after 30000ms".
 * ROOT CAUSE: the live path re-rates every order with forceRefresh (no cache); each order's carrier
 * fan-out queues behind the global rate limiter (RATE_FETCH_CONCURRENCY=4), and the 30s per-order
 * timeout wrapped that QUEUE WAIT — under a 40+ order burst at backfill-concurrency 4 most orders timed
 * out waiting for a permit, not on a slow/broken fetch (single Browse Rate works fine).
 *
 * THE FIX (resilient batch): for the live path — (1) a larger per-order budget, (2) ONE retry on a
 * timed-out fetch (the burst has drained by the retry), and (3) a smaller live burst so orders stop
 * starving each other for limiter slots. No behavior/semantics change; awaiting-only; reversible.
 *
 *   npx tsx scripts/recalculate-all-timeout-resilience-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  runWithTimeoutAndRetry,
  isTimeoutError,
  TimeoutError,
} from '../src/services/with-timeout-retry';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

async function main() {
  // ── behavioral: the retry contract ───────────────────────────────────────────
  {
    let calls = 0;
    const out = await runWithTimeoutAndRetry(async () => { calls += 1; return 'ok'; },
      { timeoutMs: 1000, maxRetries: 1, label: 'happy' });
    check('resolves first try without retrying', out === 'ok' && calls === 1, `calls=${calls}`);
  }
  {
    // A TIMED-OUT attempt is retried; the retry (burst drained) succeeds.
    let calls = 0;
    const out = await runWithTimeoutAndRetry(async (attempt) => {
      calls += 1;
      if (attempt === 0) throw new TimeoutError('getRates(order=1)', 30000);
      return 'recovered';
    }, { timeoutMs: 1000, maxRetries: 1, label: 'retry-once' });
    check('retries a timed-out fetch once and recovers', out === 'recovered' && calls === 2, `calls=${calls}`);
  }
  {
    // Exhausting the retry budget rethrows the timeout (the row is honestly recorded as failed).
    let calls = 0;
    let thrown: unknown = null;
    try {
      await runWithTimeoutAndRetry(async () => { calls += 1; throw new TimeoutError('getRates(order=2)', 30000); },
        { timeoutMs: 1000, maxRetries: 1, label: 'exhaust' });
    } catch (err) { thrown = err; }
    check('rethrows after exhausting retries (no infinite loop)', isTimeoutError(thrown) && calls === 2, `calls=${calls}`);
  }
  {
    // A NON-timeout error is NOT retried — a real rate error surfaces immediately.
    let calls = 0;
    let thrown: unknown = null;
    try {
      await runWithTimeoutAndRetry(async () => { calls += 1; throw new Error('carrier rejected payload'); },
        { timeoutMs: 1000, maxRetries: 3, label: 'real-error' });
    } catch (err) { thrown = err; }
    check('does NOT retry a non-timeout error (fails fast)',
      thrown instanceof Error && !isTimeoutError(thrown) && calls === 1, `calls=${calls}`);
  }
  {
    // A genuinely hung fetch trips the timeout (coded), then exhausts -> throws TimeoutError.
    let thrown: unknown = null;
    try {
      await runWithTimeoutAndRetry(() => new Promise<string>(() => { /* never settles */ }),
        { timeoutMs: 20, maxRetries: 0, label: 'hang' });
    } catch (err) { thrown = err; }
    check('a hung fetch trips a coded timeout', isTimeoutError(thrown));
  }

  // ── wiring pins: rates-backfill consumes the resilient path for the LIVE recalc ──
  const backfill = readFileSync('src/services/rates-backfill.ts', 'utf8');
  check('rates-backfill imports the shared timeout+retry owner',
    /from '\.\/with-timeout-retry'/.test(backfill) && /runWithTimeoutAndRetry/.test(backfill));
  check('live recalc gets a LARGER per-order budget than the 30s passive cap',
    /LIVE_PER_ORDER_TIMEOUT_MS\s*=\s*\d{2,}_?\d{3}/.test(backfill) &&
    /PER_ORDER_TIMEOUT_MS\s*=\s*30_000/.test(backfill));
  // Repointed (guard rot): PS-348 re-expressed the live-path ternaries through
  // liveRateBudget (derived from liveRecalculate) and the rateFetchDecision owner.
  check('the per-order timeout is chosen by liveRecalculate',
    /const liveRateBudget = backfillUsesLiveRateBudget\(\{ liveRecalculate, mode: opts\.mode \}\)/.test(backfill) &&
    /liveRateBudget \? LIVE_PER_ORDER_TIMEOUT_MS : PER_ORDER_TIMEOUT_MS/.test(backfill));
  check('getRates runs through runWithTimeoutAndRetry with a bounded retry on the live path',
    /runWithTimeoutAndRetry\(/.test(backfill) && /maxRetries: rateFetchDecision\.forceRefresh \? LIVE_MAX_RETRIES : 0/.test(backfill));
  check('the live burst is throttled below the passive concurrency (orders stop starving the limiter)',
    /liveRateBudget \? LIVE_BACKFILL_CONCURRENCY/.test(backfill));
  // Preserve the PS-12x forceRefresh contract (the existing recalculate-all-live guard pins it too).
  check('live recalc still forces the full live carrier fan-out (no cache regression)',
    /getRates\(rateInput, toGetRatesOptions\(rateFetchDecision\)\)/.test(backfill));

  if (failures > 0) {
    console.error(`\nFAIL recalculate-all timeout-resilience guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS recalculate-all timeout-resilience guard');
}

void main();
