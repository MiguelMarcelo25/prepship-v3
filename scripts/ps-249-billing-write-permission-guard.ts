/**
 * PS-249 (Card 4) guard — broad billing mutations require financials:write
 * (read != write). Canonical tenant-scoped generation uses billing:generate.
 *
 * BEHAVIORAL: runs hasAppPermission to prove the financials:write role matrix.
 * STATIC: broad mutations carry financials:write, generation carries
 * billing:generate, and the router-wide financials:read gate is intact.
 *
 *   npx tsx scripts/ps-249-billing-write-permission-guard.ts
 */
import { readFileSync } from 'node:fs';

// auth.ts imports lib/env (validates at load) — serverless mode + dummy URLs so we can import offline.
process.env.VERCEL = '1';
process.env.DATABASE_URL ??= 'postgres://u:p@localhost:5432/db';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const { hasAppPermission } = await import('../src/middleware/auth');

// ── behavioral: only internal finance roles get financials:write ──────────────────────────────
check('operator has financials:write', hasAppPermission({ role: 'operator' }, 'financials:write') === true);
check('admin has financials:write', hasAppPermission({ role: 'admin' }, 'financials:write') === true);
check('client_user lacks financials:write', hasAppPermission({ role: 'client_user' }, 'financials:write') === false);
check('read_only_support lacks financials:write', hasAppPermission({ role: 'read_only_support' }, 'financials:write') === false);
check('client_user has narrow billing:generate', hasAppPermission({ role: 'client_user' }, 'billing:generate') === true);
check('read_only_support lacks billing:generate', hasAppPermission({ role: 'read_only_support' }, 'billing:generate') === false);

// ── static: billing mutations gated + read gate intact ────────────────────────────────────────
const billing = readFileSync('src/routes/billing.ts', 'utf8');
const writeGates = (billing.match(/requirePermission\('financials:write'\)/g) || []).length;
check('all billing mutation routes carry financials:write (>= 7)', writeGates >= 7);

const gate = "requirePermission('financials:write')";
check('POST /generate uses narrow billing:generate gate',
  billing.includes("app.post('/generate', requirePermission('billing:generate')"));
check('PATCH /details/:orderId is admin-only and financially gated',
  billing.includes(`app.patch('/details/:orderId{[0-9]+}', requireAdmin, ${gate}`));
check('PUT /package-prices gated', billing.includes(`app.put('/package-prices', ${gate}`));
check('POST /backfill-ref-rates gated', billing.includes(`app.post('/backfill-ref-rates', ${gate}`));

check('router-wide financials:read gate still present',
  /app\.use\('\*', requirePermission\('financials:read'\)\)/.test(billing));

check('package.json wires test:ps-249-billing-write-permission',
  /test:ps-249-billing-write-permission/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-249 billing write-permission guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-249 billing write-permission guard');
