/**
 * RC1 retry guard — offline proof of the per-carrier transient-retry contract (the "Rate unavailable"
 * fix). Proves: the classifier separates TRANSIENT (timeout/429/5xx/network) from TERMINAL (4xx/no-
 * service), and the retry loop retries ONLY transient results, is bounded by maxRetries, and never
 * retries a terminal result. No network or DB.
 */
import {
  isTransientCarrierRateError,
  runWithTransientRetry,
  rateResultIsCacheable,
} from '../src/services/carrier-estimate-retry.js';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

async function main(): Promise<void> {
  // ── Classifier: TRANSIENT ──
  check('timeout message is transient', isTransientCarrierRateError(new Error('shipstation:ups rate request timed out after 25s')));
  check('HTTP 429 status is transient', isTransientCarrierRateError({ status: 429 }));
  check('HTTP 503 statusCode is transient', isTransientCarrierRateError({ statusCode: 503 }));
  check('5xx in message is transient', isTransientCarrierRateError(new Error('ShipStation responded 500 Internal Server Error')));
  check('ECONNRESET is transient', isTransientCarrierRateError(new Error('read ECONNRESET')));
  check('fetch failed is transient', isTransientCarrierRateError(new Error('fetch failed')));

  // ── Classifier: TERMINAL ──
  check('HTTP 400 status is terminal', !isTransientCarrierRateError({ status: 400 }));
  check('HTTP 404 status is terminal', !isTransientCarrierRateError({ status: 404 }));
  check('a no-service message is terminal', !isTransientCarrierRateError(new Error('no rates available for this route')));
  check('null/undefined is not transient', !isTransientCarrierRateError(null) && !isTransientCarrierRateError(undefined));
  // Precedence: an explicit 4xx STATUS wins over a transient-looking MESSAGE (don't retry a real 400).
  check('a 4xx Error whose message says "timed out" is TERMINAL (status wins over message)',
    !isTransientCarrierRateError(Object.assign(new Error('rate request timed out after 25s'), { status: 400 })));

  // ── Retry loop (inject no-op sleep + zero jitter for determinism) ──
  const opts = { maxRetries: 1, baseDelayMs: 1, sleep: async () => {}, jitter: () => 0 };

  // transient once → retried → returns the success on the 2nd attempt.
  let calls1 = 0;
  const r1 = await runWithTransientRetry<{ ok: boolean }>(
    async () => { calls1 += 1; return calls1 === 1 ? { ok: false } : { ok: true }; },
    (r) => !r.ok,
    opts,
  );
  check('transient-once is retried and returns the success (exactly 2 attempts)', r1.ok === true && calls1 === 2);

  // terminal first → not retryable → exactly 1 attempt.
  let calls2 = 0;
  await runWithTransientRetry<{ ok: boolean; terminal: boolean }>(
    async () => { calls2 += 1; return { ok: false, terminal: true }; },
    (r) => !r.ok && !r.terminal,
    opts,
  );
  check('a terminal failure is NOT retried (exactly 1 attempt)', calls2 === 1);

  // always retryable → bounded at maxRetries + 1 attempts.
  let calls3 = 0;
  await runWithTransientRetry<{ ok: boolean }>(
    async () => { calls3 += 1; return { ok: false }; },
    (r) => !r.ok,
    { ...opts, maxRetries: 2 },
  );
  check('retries are bounded at maxRetries + 1 (3 attempts)', calls3 === 3);

  // maxRetries 0 → exactly 1 attempt even when retryable.
  let calls4 = 0;
  await runWithTransientRetry<{ ok: boolean }>(
    async () => { calls4 += 1; return { ok: false }; },
    (r) => !r.ok,
    { ...opts, maxRetries: 0 },
  );
  check('maxRetries=0 disables retry (exactly 1 attempt)', calls4 === 1);

  // ── RC2: cache-gate on completeness (a transient-failed set must NOT be cached as authoritative) ──
  check('transient-failed + ok set is NOT cacheable',
    !rateResultIsCacheable([{ status: 'ok' }, { status: 'failed', transient: true }]));
  check('an all-transient-empty set is NOT cacheable',
    !rateResultIsCacheable([{ status: 'failed', transient: true }]));
  check('all-ok set IS cacheable', rateResultIsCacheable([{ status: 'ok' }, { status: 'ok' }]));
  check('clean empty (terminal no-service) set IS cacheable',
    rateResultIsCacheable([{ status: 'empty' }, { status: 'empty' }]));
  check('TERMINAL-failed (transient:false) set IS cacheable',
    rateResultIsCacheable([{ status: 'failed', transient: false }]));
  check('failed without a transient flag IS cacheable (treated terminal)',
    rateResultIsCacheable([{ status: 'failed' }]));

  if (failures > 0) {
    console.error(`\nRC1/RC2 rate-estimate-retry guard FAILED with ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('\nRC1/RC2 rate-estimate-retry guard passed.');
}

void main().catch((err) => {
  console.error('RC1 rate-estimate-retry guard crashed:', err);
  process.exit(1);
});
