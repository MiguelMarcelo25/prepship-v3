/**
 * PS-259 (Card 14) — meta-ratchet: a NEW authz/scope guard must be BEHAVIORAL, not text-grep.
 *
 * ~17 of the existing authz/scope/permission/rbac guards are pure substring scans (readFileSync +
 * regex) — they pass even if the actual enforcement is deleted, so they give false green (the audit's
 * core Card-14 finding). This can't rewrite them all, but it freezes the substring-only count at a
 * CEILING that may only go DOWN: a new authz guard must import + RUN the real authz logic (like
 * ps-250-rates-scope-enforcement / ps-083-direct-carrier-assignment-scope), or convert an existing
 * one to lower the ceiling. Adding another text-grep authz guard fails the build.
 *
 *   npx tsx scripts/authz-guard-behavioral-ratchet-guard.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Substring-only authz/scope guards present on 2026-06-16. Lower this as they are converted; never raise it.
const CEILING = 16;

const DIR = 'scripts';
const NAME_RE = /(scope|authz|permission|rbac|auth-coverage)/i;
const SELF = 'authz-guard-behavioral-ratchet';

// Behavioral = imports + executes real source (src/ or web/src/) — static `from '../src/...'`
// OR dynamic `import('../src/...')` (used when the module needs env set up first) — rather than
// only string-scanning files.
function isBehavioral(content: string): boolean {
  return /(?:from |import\()\s*'\.\.\/(?:src|web\/src)\//.test(content);
}

const files = readdirSync(DIR)
  .filter((f) => (f.endsWith('.ts') || f.endsWith('.mjs')) && NAME_RE.test(f) && !f.includes(SELF))
  .sort();
const behavioral: string[] = [];
const substringOnly: string[] = [];
for (const f of files) {
  (isBehavioral(readFileSync(join(DIR, f), 'utf8')) ? behavioral : substringOnly).push(f);
}

console.log(`authz/scope guards: ${files.length} total — ${behavioral.length} behavioral, ${substringOnly.length} substring-only (ceiling ${CEILING})`);
for (const f of behavioral) console.log(`  behavioral     : ${f}`);

let failed = false;
if (behavioral.length < 1) {
  console.error('\nFAIL: no behavioral authz guard exists — Card 14 requires at least one that runs real authz logic.');
  failed = true;
}
if (substringOnly.length > CEILING) {
  console.error(`\nFAIL: ${substringOnly.length} substring-only authz guards > ceiling ${CEILING}.`);
  console.error('A NEW authz/scope guard must be BEHAVIORAL (import + run the real authz logic), not text-grep.');
  for (const f of substringOnly) console.error(`  substring-only : ${f}`);
  failed = true;
}
if (substringOnly.length < CEILING) {
  console.log(`\nNOTE: substring-only count dropped to ${substringOnly.length} — lower CEILING to ${substringOnly.length} to lock the gain.`);
}

if (failed) process.exit(1);
console.log('\nPASS authz-guard behavioral ratchet');
