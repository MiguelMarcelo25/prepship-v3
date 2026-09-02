#!/usr/bin/env tsx
/**
 * PS-520 r7 — pins the deploy workflow to the GATED commit, statically.
 *
 * Hermetic: one file read, no network, no Render call.
 *
 * WHY. On 2026-09-02 the deploy job triggered Render with no commitId, so Render built the
 * branch TIP: feb922c8's gate deployed c8fc5328 (own gate still queued), and c8fc5328's gate
 * deployed 1a9017b3 (CI still running). r6.2 pinned commitId and asserted the deploy's commit
 * at runtime — but the audit removed commitId from the workflow and every guard stayed green:
 * the runtime check fires only after Render has already been asked to build. A regression
 * could therefore start an ungated deployment before the job turned red. This guard makes
 * that regression fail in the SOT pack, before any deploy is triggered.
 *
 * It asserts the SHAPE of the contract, not literal line text, and it proves itself with
 * negative fixtures: each way the contract can be removed must make the assertion throw.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const WORKFLOW = '.github/workflows/render-auto-deploy.yml';

let passed = 0;
const failures: string[] = [];
const check = (label: string, fn: () => void): void => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    failures.push(`${label}\n        ${message}`);
    console.log(`  FAIL  ${label}\n        ${message}`);
  }
};

/** The whole contract, as one function that throws the first missing piece. */
export function assertDeployPinned(src: string): void {
  // 1. The trigger body pins THIS workflow run's commit.
  const post = src.indexOf('/v1/services/${service_id}/deploys"');
  assert.ok(post >= 0, 'no Render deploy POST found');
  const body = src.slice(post, post + 600);
  assert.ok(/"commitId\\?":\\?"\$\{GITHUB_SHA\}/.test(body), 'the deploy POST body does not pin commitId to GITHUB_SHA');

  // 2. The created deploy's commit is read back through a dotted-path-capable json_field.
  assert.ok(/json_field\(\)[\s\S]*?split\("\."\)/.test(src), 'json_field cannot read a dotted path (commit.id)');
  const readback = src.search(/deployed_commit=\$\(curl[\s\S]*?json_field commit\.id\)/);
  assert.ok(readback >= 0, 'no readback of the deploy\'s commit.id');

  // 3. A mismatch (or an empty readback) is rejected, loudly, with a non-zero return.
  const rejectAt = src.indexOf('"${deployed_commit}" != "${GITHUB_SHA}"', readback);
  assert.ok(rejectAt >= 0, 'the readback is never compared with GITHUB_SHA');
  // The `return 1` must sit inside THIS if-block — the window ends at its `fi`, so the poll
  // loop's own failure return further down cannot satisfy it.
  const fiAt = src.indexOf('\n            fi', rejectAt);
  assert.ok(fiAt > rejectAt, 'the mismatch branch has no closing fi');
  assert.ok(src.slice(rejectAt, fiAt).includes('return 1'), 'a commit mismatch does not fail the job');
  assert.ok(src.slice(readback, rejectAt).includes('-z "${deployed_commit}"'), 'an EMPTY readback is not rejected');

  // 4. Ordering: the deploy id is resolved BEFORE the readback, and the readback happens
  //    BEFORE the job starts polling the deploy to live.
  const idResolved = src.indexOf('deploy_id=$(printf');
  const poll = src.indexOf('# Poll until terminal');
  assert.ok(idResolved >= 0 && poll >= 0, 'deploy-id resolution or the poll loop is missing');
  assert.ok(idResolved < readback, 'the readback runs before the deploy id is resolved');
  assert.ok(readback < poll, 'the readback runs after the poll loop — too late to stop a wrong deploy');
}

// The workflow file is CRLF in this repository; the fixtures below anchor on '\n'.
const real = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

check('the deploy workflow pins commitId, reads the deploy\'s commit back, rejects a mismatch, before polling', () => {
  assertDeployPinned(real);
});

// ── Negative fixtures: every way to remove the contract must make the assertion throw ──────
// A guard that cannot fail protects nothing (PS-519). Each mutant is proven APPLIED (it must
// differ from the source) and proven CAUGHT.
const MUTANTS: Array<[string, (s: string) => string]> = [
  ['commitId removed from the POST body', (s) => s.replace(/,\\?"commitId\\?":\\?"\$\{GITHUB_SHA\}\\?"/, '')],
  ['commitId pinned to the branch instead of the SHA', (s) => s.replace('${GITHUB_SHA}\\"}', '${GITHUB_REF_NAME}\\"}')],
  ['the commit readback deleted', (s) => s.replace(/deployed_commit=\$\(curl[\s\S]*?json_field commit\.id\)/, 'deployed_commit="${GITHUB_SHA}"')],
  ['a mismatch only logged, never failed', (s) => s.replace(/(!= "\$\{GITHUB_SHA\}" \]; then[\s\S]*?)return 1/, '$1true')],
  ['an empty readback accepted', (s) => s.replace('[ -z "${deployed_commit}" ] || ', '')],
  ['json_field flattened (commit.id unreadable)', (s) => s.replace('process.argv[1].split(".").reduce((o,k)=>(o==null?undefined:o[k]),JSON.parse(s)||{})', '(JSON.parse(s)||{})[process.argv[1]]')],
  ['the readback moved after the poll loop', (s) => {
    const m = s.match(/(            deployed_commit=\$\(curl[\s\S]*?✓"\n)/);
    if (!m) return s;
    const without = s.replace(m[1]!, '');
    const marker = '            # Poll until terminal';
    const at = without.indexOf(marker);
    const endOfPoll = without.indexOf('::endgroup::', at);
    return without.slice(0, endOfPoll) + m[1]! + without.slice(endOfPoll);
  }],
];
for (const [label, mutate] of MUTANTS) {
  check(`negative fixture: ${label} → the guard goes red`, () => {
    const mutant = mutate(real);
    assert.notEqual(mutant, real, 'mutation did not apply (stale anchor)');
    assert.throws(() => assertDeployPinned(mutant), `the guard accepted a workflow with ${label}`);
  });
}

check('the guard is in the SOT pack and has an npm script (it gates nothing otherwise)', () => {
  const pkg = readFileSync('package.json', 'utf8');
  const pack = readFileSync('scripts/sot-guard-pack.mjs', 'utf8');
  assert.ok(pkg.includes('"test:ps-520-render-deploy-pin"'), 'missing npm script');
  assert.ok(pack.includes("'test:ps-520-render-deploy-pin'"), 'not listed in sot-guard-pack.mjs');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFAILURES');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PS-520 render deploy pin guard passed.');
