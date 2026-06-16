/**
 * PS-251 (Card 6) — carrier HTTP calls are timeout-bounded (no hung upstream stalls a request).
 *
 * Coverage: timedFetch (the shared carrier-HTTP chokepoint in lib/http/timing.ts) routes through
 * fetchWithTimeout, so EVERY connector label/rate/confirm call is bounded; credential-verification.ts
 * (the 17 raw verify fetches + the PS-251 SSRF home) calls fetchWithTimeout directly.
 *
 * BEHAVIORAL (offline, no network — global fetch is stubbed to hang): fetchWithTimeout aborts after the
 * timeout and throws a typed FetchTimeoutError instead of hanging.
 *
 *   npx tsx scripts/ps-251-fetch-timeout-guard.ts
 */
import { readFileSync } from 'node:fs';
import { fetchWithTimeout, FetchTimeoutError } from '../src/lib/fetch-timeout';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── behavioral: a hung upstream is aborted + surfaced as FetchTimeoutError ──
const originalFetch = globalThis.fetch;
globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;
let timedOut = false;
try {
  try {
    await fetchWithTimeout('https://hang.invalid/never', {}, 10);
  } catch (err) {
    timedOut = err instanceof FetchTimeoutError;
  }
} finally {
  globalThis.fetch = originalFetch;
}
check('fetchWithTimeout aborts a hung upstream and throws FetchTimeoutError', timedOut);

// ── the helper uses AbortController + a cleared timer ──
const helper = readFileSync('src/lib/fetch-timeout.ts', 'utf8');
check('helper uses AbortController + setTimeout(abort) + clearTimeout',
  /new AbortController\(\)/.test(helper) && /setTimeout\(\(\) => controller\.abort\(\)/.test(helper) && /clearTimeout\(timer\)/.test(helper));

// ── timedFetch chokepoint routes through fetchWithTimeout ──
const timing = readFileSync('src/lib/http/timing.ts', 'utf8');
check('timedFetch (the carrier-HTTP chokepoint) routes through fetchWithTimeout',
  /import \{ fetchWithTimeout \} from '\.\.\/fetch-timeout\.js'/.test(timing) &&
  /await fetchWithTimeout\(input, init \?\? \{\}\)/.test(timing));

// ── credential-verification.ts uses fetchWithTimeout, not raw fetch ──
const credvfy = readFileSync('src/connectors/carrier/credential-verification.ts', 'utf8');
check('credential-verification calls fetchWithTimeout', /await fetchWithTimeout\(/.test(credvfy));
check('credential-verification has no raw un-timed fetch left', !/await fetch\(/.test(credvfy));

check('package.json wires test:ps-251-fetch-timeout',
  /test:ps-251-fetch-timeout/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-251 fetch-timeout guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-251 fetch-timeout guard');
