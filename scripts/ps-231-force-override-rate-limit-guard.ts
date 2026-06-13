/**
 * PS-231 guard — audit + rate-limit the shipped/cancelled ?force=1 lockdown override.
 *
 * The audit half ships in PS-234 (every override -> a durable audit_log row). This
 * guard covers the rate-limit half: the pure sliding-window math + that
 * assertOrderEditable consults it, audits a throttled attempt, and 429s.
 *
 *   npx tsx scripts/ps-231-force-override-rate-limit-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  evaluateForceOverrideWindow,
  checkForceOverrideRateLimit,
  __resetForceOverrideRateLimit,
} from '../src/lib/force-override-rate-limit';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// 1. Pure window math.
const WINDOW = 60 * 60 * 1000;
const empty = evaluateForceOverrideWindow([], 1_000_000, 3, WINDOW);
check('empty history is allowed', empty.allowed && empty.remaining === 2);

const atLimit = evaluateForceOverrideWindow([1_000_000, 1_000_001, 1_000_002], 1_000_003, 3, WINDOW);
check('at the limit is denied', !atLimit.allowed && atLimit.remaining === 0);
check('denied result reports a positive retryAfterMs', atLimit.retryAfterMs > 0 && atLimit.retryAfterMs <= WINDOW);

const expired = evaluateForceOverrideWindow([1, 2, 3], 10 * WINDOW, 3, WINDOW);
check('timestamps older than the window are pruned and allowed', expired.allowed && expired.kept.length === 0);

const partial = evaluateForceOverrideWindow([1_000_000], 1_000_000 + WINDOW + 1, 3, WINDOW);
check('mixed expiry keeps only in-window entries', partial.allowed && partial.kept.length === 0);

// 2. Impure check-and-record honors the env-configured max.
process.env.FORCE_OVERRIDE_MAX_PER_HOUR = '2';
__resetForceOverrideRateLimit();
const a1 = checkForceOverrideRateLimit('admin@x.com');
const a2 = checkForceOverrideRateLimit('admin@x.com');
const a3 = checkForceOverrideRateLimit('admin@x.com');
check('first two overrides allowed under max=2', a1.allowed && a2.allowed);
check('third override denied under max=2', !a3.allowed && a3.retryAfterMs > 0);
const other = checkForceOverrideRateLimit('other@x.com');
check('rate limit is per-actor (different admin unaffected)', other.allowed);

// 3. Source pins on the route wiring.
const orders = readFileSync('src/routes/orders.ts', 'utf8');
check('assertOrderEditable consults the rate limiter', orders.includes('checkForceOverrideRateLimit(callerEmail)'));
check('a throttled override is audited', orders.includes("action: 'force_override_throttled'"));
check('a throttled override returns 429', /retryAfterMs: rl\.retryAfterMs[\s\S]*?\},\s*429,/.test(orders));
check('a successful override is still audited (PS-234)', orders.includes("action: 'force_override'"));

const mod = readFileSync('src/lib/force-override-rate-limit.ts', 'utf8');
check('limit is env-configurable', mod.includes('FORCE_OVERRIDE_MAX_PER_HOUR'));

const pkg = readFileSync('package.json', 'utf8');
check('package.json exposes test:ps-231-force-override-rate-limit', /test:ps-231-force-override-rate-limit/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-231 force-override rate-limit guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-231 force-override rate-limit guard');
