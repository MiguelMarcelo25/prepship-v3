/**
 * PS-285 auth/scope evidence guard.
 *
 * Offline/static only. Pins phase 3 of the PS-285 umbrella to behavioral
 * permission/scope guards and the zero substring-only authz ratchet.
 */
import { existsSync, readFileSync } from 'node:fs';

// This guard itself is an auth/scope guard, so it must be behavioral under the
// authz ratchet. Import the real permission owner in serverless/dummy-env mode.
process.env.VERCEL = '1';
process.env.DATABASE_URL ??= 'postgres://u:p@localhost:5432/db';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function missing(text: string, values: string[]): string[] {
  return values.filter((value) => !text.includes(value));
}

const docPath = 'docs/ps-tickets/ps-285-auth-scope-evidence.md';
const doc = read(docPath);
const normalizedDoc = doc.replace(/\s+/g, ' ');
const checklist = read('docs/ps-tickets/ps-285-phase-checklist.md');
const matrix = read('docs/ps-tickets/ps-285-phase-evidence-matrix.md');
const packageJson = read('package.json');
const financials = read('scripts/ps-246-financials-write-permission-guard.ts');
const rls = read('scripts/ps-246-behavioral-rls-matrix-guard.ts');
const jwt = read('scripts/ps-246-jwt-audit-soak-guard.ts');
const ratesScope = read('scripts/ps-250-rates-scope-enforcement-guard.ts');
const catalogAuthz = read('scripts/ps-252-catalog-mutation-authz-guard.ts');
const ratchet = read('scripts/authz-guard-behavioral-ratchet-guard.ts');
const { hasAppPermission } = await import('../src/middleware/auth');

check('PS-285 auth/scope evidence doc exists', existsSync(docPath));
check('auth/scope packet keeps PS-285 conservative at 75%',
  /Current completion estimate: PS-285 75%/.test(doc));
check('auth/scope packet explicitly refuses Final Review readiness',
  /does not make PS-285 Final Review-ready/i.test(normalizedDoc));

const ownerFiles = [
  'scripts/ps-246-financials-write-permission-guard.ts',
  'scripts/ps-246-behavioral-rls-matrix-guard.ts',
  'scripts/ps-246-jwt-audit-soak-guard.ts',
  'scripts/ps-250-rates-scope-enforcement-guard.ts',
  'scripts/ps-252-catalog-mutation-authz-guard.ts',
  'scripts/authz-guard-behavioral-ratchet-guard.ts',
  'scripts/ps-285-auth-scope-evidence-guard.ts',
];
check('packet lists auth/scope owners',
  missing(doc, ownerFiles).length === 0,
  missing(doc, ownerFiles));

const requiredCommands = [
  'test:ps-246-financials-write-permission',
  'test:ps-246-behavioral-rls-matrix',
  'test:ps-246-jwt-audit-soak',
  'test:ps-250-rates-scope-enforcement',
  'test:ps-252-catalog-mutation-authz',
  'test:authz-guard-behavioral-ratchet',
  'test:ps-285-auth-scope-evidence',
  'test:ps-285-phase-evidence-matrix',
  'test:ps-285-umbrella-closeout',
  'npm run typecheck',
  'npm run build:web',
];
check('packet lists focused and global verification commands',
  missing(doc, requiredCommands).length === 0,
  missing(doc, requiredCommands));

check('package wires PS-285 auth/scope evidence guard',
  /"test:ps-285-auth-scope-evidence"\s*:\s*"tsx scripts\/ps-285-auth-scope-evidence-guard\.ts"/.test(packageJson));
for (const command of requiredCommands.filter((value) => value.startsWith('test:'))) {
  check(`package keeps ${command} wired`, packageJson.includes(`"${command}"`));
}

check('financials write guard imports and runs the real permission owner',
  /await import\('\.\.\/src\/middleware\/auth'\)/.test(financials) &&
    /hasAppPermission\(\{ role: 'operator' \}, 'financials:write'\)/.test(financials) &&
    /hasAppPermission\(\{ role: 'client_user' \}, 'financials:write'\)/.test(financials));
check('this aggregate guard also runs the real permission owner',
  hasAppPermission({ role: 'operator' }, 'financials:write') === true &&
    hasAppPermission({ role: 'client_user' }, 'financials:write') === false);
check('behavioral RLS guard imports and runs real client/store scope helpers',
  /from '\.\.\/src\/lib\/client-store-scope'/.test(rls) &&
    /from '\.\.\/src\/lib\/scope-predicates'/.test(rls) &&
    /fails closed/.test(rls));
check('jwt audit soak remains wired to auth/session source checks',
  /jwt/i.test(jwt) &&
    /test:ps-246-jwt-audit-soak/.test(packageJson));
check('rates scope guard imports and runs the order-scope owner',
  /from '\.\.\/src\/lib\/order-scope'/.test(ratesScope) &&
    /isOrderRowInScope/.test(ratesScope) &&
    /scope:global/.test(ratesScope));
check('catalog mutation guard runs real hasAppPermission owner',
  /await import\('\.\.\/src\/middleware\/auth'\)/.test(catalogAuthz) &&
    /hasAppPermission/.test(catalogAuthz) &&
    /settings:write/.test(catalogAuthz));
check('authz behavioral ratchet ceiling is zero',
  /const CEILING = 0;/.test(ratchet) &&
    /Substring-only authz\/scope guards remaining/.test(ratchet));

check('phase 3 is complete in checklist and matrix',
  /\|\s*3\s*\|\s*Auth and scope behavioral ratchets\s*\|\s*Complete\s*\|/i.test(checklist) &&
    /\|\s*3\s*\|\s*Auth and scope behavioral ratchets\s*\|\s*Complete\s*\|/i.test(matrix));
check('phase 2 remains in progress because golden capture is operational',
  /\|\s*2\s*\|\s*Verification harness and baseline resolver\s*\|\s*In progress\s*\|/i.test(checklist) &&
    /Golden\/baseline operational capture remains separate/.test(checklist));
check('checklist and matrix keep PS-285 at 75% and not Final Review-ready',
  /Current completion estimate: PS-285 75%/.test(checklist) &&
    /Current completion estimate: PS-285 75%/.test(matrix) &&
    /not Final Review-ready/i.test(checklist) &&
    /not Final Review-ready/i.test(matrix));

const safetyPhrases = [
  'offline/static',
  'does not capture live golden snapshots',
  'create live labels',
  'buy postage',
  'send marketplace notifications',
  'mutate production orders',
  'mutate production queues',
  'shipped/cancelled data',
  'No Trello comment',
];
check('packet carries no-live/no-mutation/no-Trello safety boundaries',
  missing(normalizedDoc, safetyPhrases).length === 0,
  missing(normalizedDoc, safetyPhrases));

if (failures > 0) {
  console.error(`\nFAIL PS-285 auth/scope evidence guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-285 auth/scope evidence guard');
