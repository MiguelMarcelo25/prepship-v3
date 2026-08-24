/**
 * PS-508 — reproducible mutation manifest (Hermes re-audit correction 6).
 *
 * Every mutation previously claimed in commit messages is encoded here as data: exact file,
 * exact find/replace, and the guard expected to kill it. The runner applies each mutant to the
 * working tree, runs the killing guard, requires a NONZERO exit, restores the file, and after
 * all mutants proves every guard is green again on clean sources. A mutant whose find-string is
 * missing or ambiguous FAILS the run — a mutation that never landed proves nothing (that exact
 * mistake happened during development: a sed that silently matched nothing reported "survived").
 *
 * Pure-layer mutants always run. The two generator-layer mutants execute the real
 * generateLineItems against PostgreSQL and run only when PS508_PG17_ADMIN_URL is set (the same
 * variable the PG17 workflow provides); without it they are reported as SKIPPED-NO-PG, never
 * silently green.
 *
 * Output: a JSON artifact on stdout binding {git SHA, mutant, guard, exit, verdict} — the
 * exact-SHA evidence the re-audit said was missing.
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const DECISION = 'src/services/customer-shipping-money-billable-decision.ts';
const GATE = 'src/services/customer-shipping-money-cutover-gate.ts';
const BILLING = 'src/services/billing.ts';

const PURE_DECISION_GUARD = 'test:ps-508-billing-consumes-frozen-tuple';
const PURE_GATE_GUARD = 'test:ps-508-cutover-gate';
const GENERATOR_GUARD = 'test:ps-508-billing-generates-frozen-line-pg17';

const MUTANTS = [
  // ---- decision owner ------------------------------------------------------------------
  { id: 'D1-ignore-frozen-tuple', file: DECISION, guard: PURE_DECISION_GUARD,
    find: '  if (frozen) {',
    replace: '  if (false && frozen) {' },
  { id: 'D2-review-fails-open-to-recompute', file: DECISION, guard: PURE_DECISION_GUARD,
    find: "  return { source: 'review', reason: reviewReason(classification) };",
    replace: "  return { source: 'legacy_recompute', value: input.recompute() };" },
  { id: 'D3-drop-suffix-requirement', file: DECISION, guard: PURE_DECISION_GUARD,
    find: "    if (typeof frozen.billingDescriptionSuffix !== 'string') {",
    replace: '    if (false) {' },
  { id: 'D4-ignore-cutover-boundary', file: DECISION, guard: PURE_DECISION_GUARD,
    find: '    if (input.afterCutover) {',
    replace: '    if (false && input.afterCutover) {' },
  // ---- activation gate + boundary ------------------------------------------------------
  { id: 'G1-empty-allowlist-fails-open', file: GATE, guard: PURE_GATE_GUARD,
    find: "  if (list === '') return false;",
    replace: "  if (list === '') return true;" },
  { id: 'G2-null-client-enabled', file: GATE, guard: PURE_GATE_GUARD,
    find: '  if (input.clientId == null) return false;',
    replace: '  if (input.clientId == null) return true;' },
  { id: 'G3-invalid-boundary-collapses-to-none', file: GATE, guard: PURE_GATE_GUARD,
    find: "  if (Number.isNaN(at.getTime())) return { kind: 'invalid', raw: value };",
    replace: "  if (Number.isNaN(at.getTime())) return { kind: 'none' };" },
  { id: 'G4-undated-shipment-fails-open', file: GATE, guard: PURE_GATE_GUARD,
    find: '  if (shipDate == null) return true;',
    replace: '  if (shipDate == null) return false;' },
  { id: 'G5-boundary-becomes-exclusive', file: GATE, guard: PURE_GATE_GUARD,
    find: '  return t >= boundary.at.getTime();',
    replace: '  return t > boundary.at.getTime();' },
  { id: 'G6-invalid-boundary-fails-open', file: GATE, guard: PURE_GATE_GUARD,
    find: "  if (boundary.kind === 'invalid') return true;",
    replace: "  if (boundary.kind === 'invalid') return false;" },
  // ---- real Billing wiring (requires PostgreSQL) ---------------------------------------
  { id: 'B1-sever-frozen-wiring', file: BILLING, guard: GENERATOR_GUARD, requiresPg: true,
    find: '        if (billableShipping) {',
    replace: '        if (false && billableShipping) {' },
  { id: 'B2-disable-review-hold', file: BILLING, guard: GENERATOR_GUARD, requiresPg: true,
    find: "      if (billableShipping?.source === 'review') {",
    replace: "      if (false && billableShipping?.source === 'review') {" },
];

const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const hasPg = Boolean(process.env.PS508_PG17_ADMIN_URL);
const results = [];
let failures = 0;

// A hard kill (timeout, SIGKILL) skips finally-blocks, and a runner that dies mid-mutant
// would leave the tree mutated — the NEXT run would then read the mutant as "original" and
// every result after that is garbage. That exact sequence happened during development. So:
// refuse to start unless every target file is clean against HEAD, restore from git (the
// authoritative original) rather than from memory, and re-restore on process exit.
const TARGET_FILES = [...new Set(MUTANTS.map((m) => m.file))];
{
  const dirty = execSync(`git status --porcelain -- ${TARGET_FILES.join(' ')}`, { encoding: 'utf8' }).trim();
  if (dirty) {
    console.error('FAIL: refusing to run — target files are dirty against HEAD (a previous run may have died mid-mutant):');
    console.error(dirty);
    process.exit(1);
  }
}
function restoreFromGit(file) {
  execSync(`git checkout -- ${file}`);
}
process.on('exit', () => {
  try { for (const f of TARGET_FILES) restoreFromGit(f); } catch { /* best effort */ }
});

function runGuard(guard) {
  const r = spawnSync('npm', ['run', '-s', guard], {
    shell: true, encoding: 'utf8', timeout: 900_000,
    env: { ...process.env },
  });
  return r.status ?? 1;
}

for (const m of MUTANTS) {
  if (m.requiresPg && !hasPg) {
    results.push({ id: m.id, guard: m.guard, verdict: 'SKIPPED-NO-PG' });
    console.error(`skip ${m.id} — PS508_PG17_ADMIN_URL not set`);
    continue;
  }
  const original = fs.readFileSync(m.file, 'utf8');
  const count = original.split(m.find).length - 1;
  if (count !== 1) {
    failures += 1;
    results.push({ id: m.id, guard: m.guard, verdict: 'FIND-STRING-BROKEN', occurrences: count });
    console.error(`FAIL ${m.id} — find-string occurs ${count}x (must be exactly 1); the mutant no longer lands`);
    continue;
  }
  fs.writeFileSync(m.file, original.replace(m.find, m.replace));
  let exit;
  try {
    exit = runGuard(m.guard);
  } finally {
    restoreFromGit(m.file);
  }
  const killed = exit !== 0;
  if (!killed) failures += 1;
  results.push({ id: m.id, guard: m.guard, exit, verdict: killed ? 'KILLED' : 'SURVIVED' });
  console.error(`${killed ? 'ok  ' : 'FAIL'} ${m.id} — exit ${exit} (${killed ? 'killed' : 'SURVIVED'})`);
}

// Clean-tree proof: every guard exercised above must be green on unmutated sources.
for (const guard of [...new Set(MUTANTS.filter((m) => !m.requiresPg || hasPg).map((m) => m.guard))]) {
  const exit = runGuard(guard);
  const ok = exit === 0;
  if (!ok) failures += 1;
  results.push({ id: `clean:${guard}`, guard, exit, verdict: ok ? 'GREEN' : 'RED-ON-CLEAN-TREE' });
  console.error(`${ok ? 'ok  ' : 'FAIL'} clean-tree ${guard} — exit ${exit}`);
}

console.log(JSON.stringify({ sha, hasPg, results }, null, 2));
process.exit(failures === 0 ? 0 : 1);
