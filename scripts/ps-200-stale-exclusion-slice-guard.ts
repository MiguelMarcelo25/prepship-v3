/**
 * PS-200 guard — stale rewrite-exclusion tokens are removed from vercel.json,
 * WITHOUT weakening the still-live or blocked exclusions.
 *
 * Context: vercel.json proxies /api/* to the Render backend
 * (prepshipv4-api-l5xc.onrender.com) EXCEPT a negative-lookahead exclusion set
 * still served by legacy Vercel functions. The `debug-env` and `migrate-from`
 * one-shot tools were deleted in PS-200 S7 — there is no api/ implementation,
 * no Render route, and no FE caller, so both paths 404 on BOTH backends before
 * and after this change (behavior-neutral). Their exclusion tokens were dead
 * weight; this slice removes ONLY those two.
 *
 * It deliberately keeps the remaining exclusions that are still gated on DJ's
 * operational decisions:
 *   - carrier-accounts / carriers/ / store-accounts → S8 business-day
 *     zero-invocation cutover acceptance
 *   - oauth/                                        → S4 eBay OAuth RuName
 *     re-registration (external)
 *   - admin/                                        → activation decision
 *     (incl. destructive purge-test-orders)
 *
 * PS-200 S3 follow-up: cron/ was removed after scheduler ownership was proven:
 * Walmart fees runs on the v4 worker in both scheduler paths and api/cron is
 * deleted, so /api/cron/* may proxy to Render /cron/*.
 *
 *   npx tsx scripts/ps-200-stale-exclusion-slice-guard.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
  rewrites?: Array<{ source?: string; destination?: string }>;
};
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts?: Record<string, string>;
};

const apiRewrite = (vercel.rewrites ?? []).find(
  (r) => typeof r.source === 'string' && r.source.startsWith('/api/:path'),
);
assert.ok(apiRewrite?.source, 'vercel.json must keep the /api/:path rewrite to Render');
const source = apiRewrite.source as string;
assert.ok(
  /onrender\.com/.test(apiRewrite.destination ?? ''),
  'the /api rewrite must still target the Render backend',
);

// 1. The stale exclusions are GONE.
for (const stale of ['debug-env', 'migrate-from', 'cron/']) {
  assert.ok(
    !source.includes(stale),
    `vercel.json /api rewrite must not list the stale exclusion '${stale}'`,
  );
}

// 2. The still-live / blocked exclusions REMAIN.
for (const live of ['carrier-accounts', 'carriers/', 'store-accounts', 'oauth/', 'admin/']) {
  assert.ok(
    source.includes(live),
    `vercel.json /api rewrite must still exclude '${live}' (cutover/blocked — not part of this slice)`,
  );
}

// 3. The stale tools have no legacy api/ implementation.
assert.ok(
  !existsSync('api/debug-env.ts') &&
    !existsSync('api/migrate-from.ts') &&
    !existsSync('api/cron/sync-walmart-fees.ts') &&
    !existsSync('api/cron'),
  'no legacy debug/migrate api tools or api/cron folder may exist',
);

// 4. Self-wiring.
assert.equal(
  pkg.scripts?.['test:ps-200-stale-exclusion-slice'],
  'tsx scripts/ps-200-stale-exclusion-slice-guard.ts',
  'package.json must expose test:ps-200-stale-exclusion-slice',
);

console.log('PASS ps-200 stale-exclusion slice guard');
