/**
 * PS-226 guard — HTTP security headers on document responses (vercel.json).
 *
 * The live site previously sent only HSTS + Cache-Control. This pins that the
 * non-asset (document) route now also sends X-Frame-Options, nosniff,
 * Referrer-Policy, Permissions-Policy, and a CSP (Report-Only first, to tune),
 * without regressing the asset Cache-Control rule. Live proof = `curl -I` (DJ).
 *
 *   npx tsx scripts/ps-226-security-headers-guard.ts
 */
import { readFileSync } from 'node:fs';

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const headerRules: Array<{ source: string; headers: Array<{ key: string; value: string }> }> =
  vercel.headers ?? [];
const docRule = headerRules.find((r) => r.source === '/((?!assets/).*)');
const assetRule = headerRules.find((r) => r.source === '/assets/(.*)');

check('document (non-asset) header rule exists', !!docRule);
check('asset cache rule still present (no regression)', !!assetRule
  && assetRule.headers.some((h) => h.key === 'Cache-Control' && /immutable/.test(h.value)));

const byKey = new Map((docRule?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]));

check('document route keeps Cache-Control no-store', /no-store/.test(byKey.get('cache-control') ?? ''));
check('X-Frame-Options: DENY', (byKey.get('x-frame-options') ?? '') === 'DENY');
check('X-Content-Type-Options: nosniff', (byKey.get('x-content-type-options') ?? '') === 'nosniff');
check('Referrer-Policy set', /strict-origin/.test(byKey.get('referrer-policy') ?? ''));
check('Permissions-Policy locks geolocation/mic/camera',
  /geolocation=\(\)/.test(byKey.get('permissions-policy') ?? '')
  && /camera=\(\)/.test(byKey.get('permissions-policy') ?? ''));

const csp = byKey.get('content-security-policy-report-only') ?? byKey.get('content-security-policy') ?? '';
check('CSP present', csp.length > 0);
check('CSP starts in Report-Only (safe tuning)', byKey.has('content-security-policy-report-only'));
check('CSP default-src self', /default-src 'self'/.test(csp));
check('CSP frame-ancestors none (clickjacking)', /frame-ancestors 'none'/.test(csp));
check('CSP connect-src allows Supabase + Render API',
  /connect-src[^;]*\*\.supabase\.co/.test(csp) && /connect-src[^;]*prepshipv4-api-l5xc\.onrender\.com/.test(csp));
check('CSP object-src none', /object-src 'none'/.test(csp));

const pkg = readFileSync('package.json', 'utf8');
check('package.json exposes test:ps-226-security-headers', /test:ps-226-security-headers/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-226 security headers guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-226 security headers guard');
