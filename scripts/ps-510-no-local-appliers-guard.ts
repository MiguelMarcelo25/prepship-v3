/**
 * PS-510 guard — local migration appliers must not come back.
 *
 * Pure, no database. Enrolled in CI.
 *
 * Every one of the eleven real-PostgreSQL callers used to walk `drizzle/` itself, rewrite
 * concurrency with its own regex, and swallow failures. That is how two of migration 0104's
 * occurrence-identity objects went missing while every lane stayed green — confirmed by hosted
 * readback (run 33121719782): ABSENT/COMPROMISED.
 *
 * This guard fails if any of those three habits reappears in a script that talks to a real
 * database. It checks BEHAVIOUR-BEARING patterns, not prose: matches inside comments and
 * string literals are stripped first, so a file that *documents* the old defect (as several
 * deliberately do) does not trip it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(REPO_ROOT, 'scripts');

/** The canonical owner and its own contract are allowed to contain these patterns. */
const EXEMPT = new Set([
  'lib/migration-execution-plan.ts',
  'lib/migration-execution-pg.ts',
  'lib/pg17-hosted-tolerance.ts',
  'ps-510-migration-plan-contract.ts',
  'ps-510-no-local-appliers-guard.ts',
  'ps-510-prefix-catalog-reproduction-pg17.ts',
]);

/**
 * Strip COMMENTS ONLY, so prose documenting the old defect does not trip the guard.
 *
 * String-literal stripping was tried and removed: a naive quote-matching regex spans unbalanced
 * apostrophes (SQL text, English contractions left behind by comment removal) and swallows
 * arbitrary spans of real code. Measured on one caller it collapsed 7,533 characters to 1,978
 * and silently ate a reintroduced bare catch — a guard that cannot fail is worse than no guard.
 *
 * Comment removal alone is sufficient here: every pattern below is code-shaped, and a literal
 * containing `catch {}` or a concurrency rewrite would itself be worth a human look.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[\s;{}()])\/\/[^\n]*/g, '$1 ');
}

/**
 * The eleven real-PostgreSQL callers PS-510 cut over. These MUST stay clean — a regression
 * here means the cutover was undone.
 *
 * A bare catch in a script OUTSIDE this list is reported but does NOT fail the guard. Removing
 * those was explicitly rejected as a standalone visibility patch: they absorb more than the
 * 0104 failure (missing Supabase roles, foreign-owned relations, ordering artefacts,
 * unsupported fixture capabilities), so deleting them wholesale would turn lanes red without
 * establishing why. They belong to their own scoped work, not to PS-510.
 */
const PS510_CUTOVER = new Set([
  'ps-494-joined-origin-pg17.ts',
  'ps-508-billing-generates-frozen-line-pg17.ts',
  'ps-497-occurrence-worker-pg17.ts',
  'ps-497-occurrence-worker-execoff-pg17.ts',
  'ps-497-owner-resolver-e2e-pg17.ts',
  'ps-497-review-resolver-pg17.ts',
  'ps-497-supersession-pg17.ts',
  'ps-497-worker-retry-hardening-pg17.ts',
  'ps-497-shipped-outcome-invariant-integration.ts',
  'ps-497-flags-off-pg17.ts',
  'ps-497-owner-cutover-pg17.ts',
]);

/**
 * PGlite fidelity consumers. Explicitly assigned to PS-511, not PS-510 — the split is by
 * RUNTIME, not by symptom. They should consume the same planner eventually, but their
 * capability downgrades, reporting, catalog substitutes and truthful evidence claims are
 * PS-511's contract to define.
 *
 * Reported on every run so the debt stays visible. Deliberately NOT silently exempted: an
 * exemption hides work, a deferral names it.
 */
const PS511_DEFERRED = new Set([
  'ps-507-qa-stack.mjs',
  'ps-497-shipped-outcome-invariant-pglite.ts',
  'ps-499-route-harness.ts',
  'ps-424-order-lifecycle-command-integration.ts',
]);

interface Violation { file: string; rule: string; detail: string }

const RULES: Array<{ name: string; test: RegExp; detail: string }> = [
  {
    name: 'unique-blind concurrency rewrite',
    test: /replace\s*\(\s*\/CREATE\\s\+INDEX\\s\+CONCURRENTLY/i,
    detail: 'this pattern is UNIQUE-blind — CREATE UNIQUE INDEX CONCURRENTLY does not match it. '
      + 'Delegate to applyMigrations() instead; it routes concurrency into the autocommit phase.',
  },
  {
    name: 'concurrency stripping',
    test: /replace\s*\(\s*\/\s*concurrently/i,
    detail: 'stripping CONCURRENTLY produces a schema that differs from the one migrations define. '
      + 'Delegate to applyMigrations(), which keeps every statement verbatim.',
  },
  {
    name: 'local migration directory walk',
    test: /readdirSync\s*\([^)]*drizzle/i,
    detail: 'walking drizzle/ locally is duplicate authority over the migration chain. '
      + 'Delegate to applyMigrations({ dir }) or planMigrations().',
  },
  {
    name: 'bare catch around statement execution',
    test: /catch\s*(?:\(\s*\)\s*)?\{\s*\}/,
    detail: 'a bare catch tolerates every error from every migration for no stated reason. '
      + 'Supply an explicit filename + SQLSTATE + reason tolerance rule instead.',
  },
];

const violations: Violation[] = [];
const outOfScope: Violation[] = [];
let scanned = 0;

function walk(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(ts|mjs)$/.test(entry.name)) continue;
    const rel = path.relative(SCRIPTS, full).replace(/\\/g, '/');
    if (EXEMPT.has(rel)) continue;

    const source = fs.readFileSync(full, 'utf8');
    // Only scripts that actually execute SQL against a database are in scope.
    if (!/\bunsafe\s*\(|from 'postgres'|require\('postgres'\)/.test(source)) continue;
    scanned += 1;

    const code = codeOnly(source);
    for (const rule of RULES) {
      if (!rule.test.test(code)) continue;
      // Applier authority (rewrites, directory walks) is fatal anywhere. A bare catch is fatal
      // only in the cut-over callers; elsewhere it is reported, per the rejected option (c).
      const fatal = !PS511_DEFERRED.has(rel)
        && (rule.name !== 'bare catch around statement execution' || PS510_CUTOVER.has(rel));
      (fatal ? violations : outOfScope).push({ file: rel, rule: rule.name, detail: rule.detail });
    }
  }
}

walk(SCRIPTS);

// Every cut-over caller must still exist and still delegate. A caller silently deleted or
// renamed would otherwise pass this guard by absence.
const missing = [...PS510_CUTOVER].filter((f) => !fs.existsSync(path.join(SCRIPTS, f)));
if (missing.length > 0) {
  console.error(`FAIL: cut-over caller(s) missing from scripts/: ${missing.join(', ')}`);
  process.exit(1);
}
const notDelegating = [...PS510_CUTOVER].filter((f) =>
  !fs.readFileSync(path.join(SCRIPTS, f), 'utf8').includes('migration-execution-pg.js'));
if (notDelegating.length > 0) {
  console.error(`FAIL: cut-over caller(s) no longer delegate to the canonical owner: ${notDelegating.join(', ')}`);
  process.exit(1);
}

if (outOfScope.length > 0) {
  console.log('NOTE — bare catches outside PS-510 scope. Reported, not failed: removing these was');
  console.log('rejected as a standalone visibility patch. They absorb more than the 0104 failure and');
  console.log('need their own scoped work with a stated reason per case.');
  for (const v of outOfScope) console.log(`  ${v.file}`);
  console.log('');
}

if (violations.length > 0) {
  console.error('FAIL PS-510 no-local-appliers guard\n');
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    ${v.rule}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(`${violations.length} violation(s) across ${scanned} database-touching scripts.`);
  process.exit(1);
}

console.log(`PASS PS-510 no-local-appliers guard — ${scanned} database-touching scripts scanned; `
  + `all ${PS510_CUTOVER.size} cut-over callers delegate to the canonical owner; `
  + `0 concurrency rewrites, 0 local chain walks, 0 in-scope bare catches`);
