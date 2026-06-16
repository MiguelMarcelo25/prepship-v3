/**
 * PS-252 (Card 7) guard — global-catalog MUTATIONS require settings:write (internal); a
 * portal/client_user can't edit the shared products/locations catalog.
 *
 * BEHAVIORAL: runs the real hasAppPermission to prove the role matrix for the gate's permission.
 * STATIC: the create/update/delete catalog routes carry requireInternalPermission('settings:write').
 *
 *   npx tsx scripts/ps-252-catalog-mutation-authz-guard.ts
 */
import { readFileSync } from 'node:fs';

// auth.ts imports lib/env, which validates required vars at load. Put it in serverless mode (so the
// Supabase admin secrets aren't required) + supply dummy URLs so we can import the permission logic
// offline. Must run BEFORE the dynamic import below.
process.env.VERCEL = '1';
process.env.DATABASE_URL ??= 'postgres://u:p@localhost:5432/db';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const { hasAppPermission } = await import('../src/middleware/auth');

// ── behavioral: the gate's permission (settings:write) is internal-staff only ─────────────────
check('client_user (portal) lacks settings:write', hasAppPermission({ role: 'client_user' }, 'settings:write') === false);
check('read_only_support lacks settings:write', hasAppPermission({ role: 'read_only_support' }, 'settings:write') === false);
check('operator has settings:write', hasAppPermission({ role: 'operator' }, 'settings:write') === true);
check('admin has settings:write', hasAppPermission({ role: 'admin' }, 'settings:write') === true);

// ── static: the catalog mutation routes are gated ─────────────────────────────────────────────
const products = readFileSync('src/routes/products.ts', 'utf8');
const locations = readFileSync('src/routes/locations.ts', 'utf8');
check('products imports requireInternalPermission', /import \{ requireInternalPermission \} from '\.\.\/middleware\/auth'/.test(products));
check('locations imports requireInternalPermission', /import \{ requireInternalPermission \} from '\.\.\/middleware\/auth'/.test(locations));

const gate = "requireInternalPermission('settings:write')";
check('products POST / gated', products.includes(`app.post('/', ${gate}`));
check('products PATCH /:id gated', products.includes(`app.patch('/:id{[0-9]+}', ${gate}`));
check('products DELETE /:id gated', products.includes(`app.delete('/:id{[0-9]+}', ${gate}`));
check('products POST /save-defaults gated', products.includes(`app.post('/save-defaults', ${gate}`));
check('locations POST / gated', locations.includes(`app.post('/', ${gate}`));
check('locations PATCH /:id gated', locations.includes(`app.patch('/:id{[0-9]+}', ${gate}`));
check('locations DELETE /:id gated', locations.includes(`app.delete('/:id{[0-9]+}', ${gate}`));
check('locations POST /:id/default gated', locations.includes(`app.post('/:id{[0-9]+}/default', ${gate}`));

// packages: only DELETE (pure config) is gated — POST/PATCH/PUT carry stockQty (dual-purpose), left ungated.
const packages = readFileSync('src/routes/packages.ts', 'utf8');
check('packages DELETE /:id gated (config-only route)', packages.includes(`app.delete('/:id{[0-9]+}', ${gate}`));

// PS-252 finish: parent-SKU catalog mutations (pure config) are gated; reads (list + detail) stay open.
const parentSkus = readFileSync('src/routes/parent-skus.ts', 'utf8');
const parentFlat = parentSkus.replace(/\s+/g, '');
check('parent-skus imports requireInternalPermission',
  /import \{ requireInternalPermission \} from '\.\.\/middleware\/auth'/.test(parentSkus));
check('parent-skus POST / gated', parentSkus.includes(`app.post('/', ${gate}`));
check('parent-skus PATCH /:id gated', parentFlat.includes(`app.patch('/:id{[0-9]+}',${gate}`));
check('parent-skus DELETE /:id gated', parentSkus.includes(`app.delete('/:id{[0-9]+}', ${gate}`));

check('package.json wires test:ps-252-catalog-mutation-authz',
  /test:ps-252-catalog-mutation-authz/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-252 catalog-mutation authz guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-252 catalog-mutation authz guard');
