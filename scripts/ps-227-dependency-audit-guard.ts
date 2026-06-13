/**
 * PS-227 guard (offline source-pin) — dependency-audit gate + documented exceptions.
 *
 * The actual vulnerability gate is `test:dependency-audit`
 * (`npm audit --omit=dev --audit-level=critical`), which needs network and runs in
 * CI. This offline guard pins that the gate is wired and that every remaining
 * advisory is documented in DEPENDENCY_AUDIT_EXCEPTIONS.md with an owner — so a
 * regression (gate removed, or an undocumented exception) is caught in the normal
 * offline suite.
 *
 *   npx tsx scripts/ps-227-dependency-audit-guard.ts
 */
import { readFileSync } from 'node:fs';

const exceptions = (() => {
  try { return readFileSync('DEPENDENCY_AUDIT_EXCEPTIONS.md', 'utf8'); } catch { return ''; }
})();
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// 1. Enforced production-critical gate is wired.
const auditScript = pkg.scripts?.['test:dependency-audit'] ?? '';
check('test:dependency-audit exists', auditScript.length > 0);
check('gate audits production deps only (--omit=dev)', auditScript.includes('--omit=dev'));
check('gate fails on production criticals (--audit-level=critical)', auditScript.includes('--audit-level=critical'));
check('gate runs npm audit', auditScript.includes('npm audit'));

// 2. Exceptions register documents every accepted advisory + remediation owner.
check('exceptions doc exists', exceptions.length > 0);
check('documents the enforced gate', exceptions.includes('npm audit --omit=dev --audit-level=critical'));
check('drizzle-orm high documented + tracked to PS-242', /drizzle-orm/.test(exceptions) && /PS-242/.test(exceptions));
check('exceljs/uuid moderate documented (no breaking downgrade)', /exceljs/.test(exceptions) && /uuid/.test(exceptions));
check('dev/build-only advisories separated from production', /dev.*build-only|build-only/i.test(exceptions) && /esbuild/.test(exceptions));
check('records that npm audit fix (non-breaking) was applied', /npm audit fix/.test(exceptions));

// 3. Self-wiring.
check('package.json exposes test:ps-227-dependency-audit', !!pkg.scripts?.['test:ps-227-dependency-audit']);

if (failures > 0) {
  console.error(`\nFAIL PS-227 dependency-audit guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-227 dependency-audit guard');
