/**
 * PS-256 (Card 11) guard — a DB-backed rate limiter exists so the ShipStation budget can hold
 * across processes, selected by RATE_LIMITER_BACKEND (default = the fast in-memory bucket, inert).
 *
 * BEHAVIORAL: the in-memory TokenBucket still grants a full bucket instantly (db-free, unchanged).
 * STATIC: DurableTokenBucket refills+decrements ATOMICALLY in one UPDATE on a shared row;
 * v1-client selects durable only when flagged, else in-memory; the table is runtime-ensured.
 *
 *   npx tsx scripts/ps-256-durable-rate-limiter-guard.ts
 */
import { readFileSync } from 'node:fs';
import { TokenBucket, type RateBucket } from '../src/lib/shipstation/rate-limiter';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── behavioral: the in-memory bucket is unchanged (full bucket -> instant grants) ─────────────
const bucket: RateBucket = new TokenBucket(3, 3 / 1000);
const start = Date.now();
await bucket.acquire();
await bucket.acquire();
await bucket.acquire();
check('in-memory TokenBucket grants a full bucket near-instantly', Date.now() - start < 150);

// ── static: durable bucket — atomic, shared-row, runtime-ensured ──────────────────────────────
const durable = readFileSync('src/lib/shipstation/durable-rate-limiter.ts', 'utf8');
check('runtime-ensures rate_limiter_state (500-safe additive table)',
  /CREATE TABLE IF NOT EXISTS rate_limiter_state/.test(durable) && /ensureRateLimiterSchema/.test(durable));
check('seeds the shared row with ON CONFLICT (no live-balance reset)',
  /INSERT INTO rate_limiter_state[\s\S]*ON CONFLICT \(key\) DO UPDATE/.test(durable));
check('acquire is ONE atomic refill+decrement UPDATE guarded by tokens >= 1',
  /UPDATE rate_limiter_state[\s\S]*LEAST\(capacity, tokens \+ EXTRACT\(EPOCH[\s\S]*\) \* tokens_per_sec\) - 1[\s\S]*>= 1[\s\S]*RETURNING tokens/.test(durable));
check('DurableTokenBucket exposes the same acquire() interface',
  /class DurableTokenBucket[\s\S]*async acquire\(options: \{ signal\?: AbortSignal \} = \{\}\): Promise<void>/.test(durable));

// ── static: v1-client selects backend by flag; default stays in-memory ────────────────────────
const v1 = readFileSync('src/lib/shipstation/v1-client.ts', 'utf8');
check('v1-client picks DurableTokenBucket only when RATE_LIMITER_BACKEND=durable',
  /process\.env\.RATE_LIMITER_BACKEND === 'durable'\s*\n?\s*\? new DurableTokenBucket\('shipstation-v1', 38/.test(v1));
check('v1-client default is the in-memory TokenBucket',
  /: new TokenBucket\(38, 38 \/ 60_000\)/.test(v1));

// ── static: v2 uses the same durable backend per API-key fingerprint ─────────
const v2 = readFileSync('src/lib/shipstation/client.ts', 'utf8');
check('v2-client selects durable admission when RATE_LIMITER_BACKEND=durable',
  /process\.env\.RATE_LIMITER_BACKEND === 'durable'[\s\S]*shipStationV2DurableBucket\(apiKey\)\.acquire/.test(v2));
check('v2 durable bucket is isolated by API-key fingerprint',
  /shipStationV2BucketId\(apiKey\)[\s\S]*`shipstation-v2:\$\{bucketId\}`/.test(v2));
check('background v2 admission preserves interactive burst and per-minute reserves',
  /shipStationV2DurableBackgroundBucket[\s\S]*SHIPSTATION_RATE_LIMIT_INTERACTIVE_BURST_RESERVE[\s\S]*SHIPSTATION_RATE_LIMIT_INTERACTIVE_PER_MINUTE_RESERVE/.test(v2));
check('v2 limiter waits and retries honor caller cancellation',
  /acquireShipStationV2Budget\(key, opts\.priority \?\? 'interactive', opts\.signal\)/.test(v2) &&
    /abortableDelay\(backoffMs, opts\.signal\)/.test(v2));

check('rate-limiter exports the shared RateBucket interface',
  /export interface RateBucket \{[\s\S]*acquire\(\): Promise<void>/.test(readFileSync('src/lib/shipstation/rate-limiter.ts', 'utf8')));

check('package.json wires test:ps-256-durable-rate-limiter',
  /test:ps-256-durable-rate-limiter/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-256 durable rate-limiter guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-256 durable rate-limiter guard');
