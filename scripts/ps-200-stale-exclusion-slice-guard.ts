/**
 * PS-200 guard — the STALE `debug-env` / `migrate-from` rewrite-exclusion
 * tokens are removed from vercel.json, WITHOUT weakening the still-live or
 * blocked exclusions.
 *
 * Context: vercel.json proxies /api/* to the Render backend
 * (prepshipv4-api-l5xc.onrender.com) EXCEPT a negative-lookahead exclusion set
 * still served by legacy Vercel functions. The `debug-env` and `migrate-from`
 * one-shot tools were deleted in PS-200 S7 — there is no api/ implementation,
 * no Render route, and no FE caller, so both paths 404 on BOTH backends before
 * and after this change (behavior-neutral). Their exclusion tokens were dead
 * weight; this slice removes ONLY those two.
 *
 * It deliberately does NOT touch the remaining exclusions — those flips move
 * live production traffic and are gated on DJ's operational decisions:
 *   - carrier-accounts / carriers/ / store-accounts → S8 business-day
 *     zero-invocation cutover acceptance
 *   - oauth/                                        → S4 eBay OAuth RuName
 *     re-registration (external)
 *   - admin/                                        → activation decision
 *     (incl. destructive purge-test-orders)
 *   - cron/                                         → scheduler-ownership audit
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

// 1. The two stale one-shot exclusions are GONE.
for (const stale of ['debug-env', 'migrate-from']) {
  assert.ok(
    !source.includes(stale),
    `vercel.json /api rewrite must not list the stale exclusion '${stale}' (tool deleted in PS-200 S7)`,
  );
}

// 2. The still-live / blocked exclusions REMAIN (their flips are DJ-gated and
//    must not move in this behavior-neutral slice).
for (const live of ['carrier-accounts', 'carriers/', 'store-accounts', 'oauth/', 'admin/', 'cron/']) {
  assert.ok(
    source.includes(live),
    `vercel.json /api rewrite must still exclude '${live}' (cutover/blocked — not part of this slice)`,
  );
}

// 3. The stale tools have no legacy api/ implementation (deleted in S7), so the
//    removed paths genuinely 404 on the Vercel side too.
assert.ok(
  !existsSync('api/debug-env.ts') && !existsSync('api/migrate-from.ts'),
  'no legacy api/debug-env.ts or api/migrate-from.ts may exist (deleted in PS-200 S7)',
);

// 4. Self-wiring.
assert.equal(
  pkg.scripts?.['test:ps-200-stale-exclusion-slice'],
  'tsx scripts/ps-200-stale-exclusion-slice-guard.ts',
  'package.json must expose test:ps-200-stale-exclusion-slice',
);

console.log('PASS ps-200 stale-exclusion slice guard');
