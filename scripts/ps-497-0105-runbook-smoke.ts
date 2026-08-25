// PS-497 Slice 2 (Release A round-3) — smoke test for the 0105 operator runbook. Hermes FAIL 97% found the
// runbook's mandatory digest-verification command referenced a non-existent compiled `.js` module and exited
// 1 (ERR_MODULE_NOT_FOUND). This test EXECUTES the credential-free runbook command exactly as committed and
// fails if it does not exit 0, so the documented operator step can never silently rot again. It runs no
// production command (everything else in the runbook needs a real DATABASE_URL).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNBOOK = 'scripts/ps-497-claim-status-0105-APPLY-RUNBOOK.md';
const EXPECTED_DIGEST = '62a5b82de9985bc7c396a6b75f516fcd3ac671d507973a0f18088b8ceafddc6d';
const runbook = readFileSync(path.join(REPO, RUNBOOK), 'utf8');

let passed = 0;
const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };

// 1) the runbook must not reference the non-existent compiled .js digest module (the ERR_MODULE_NOT_FOUND defect).
assert.ok(!/ps-497-claim-status-migration-digest\.js/.test(runbook), 'runbook must not import the non-existent compiled .js digest module');
assert.ok(!/\bnode -e\b[\s\S]*readVerifiedMigration/.test(runbook), 'runbook must not run the digest check with `node -e` (no .js build exists)');
ok('runbook no longer references the non-existent .js module or node -e for the digest check');

// 2) extract the credential-free digest-verification command and RUN it — it MUST exit 0 and print the digest.
const bashBlocks = [...runbook.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? '');
const digestCmd = bashBlocks.find((b) => /readVerifiedMigration/.test(b) && b.includes(EXPECTED_DIGEST));
assert.ok(digestCmd, 'runbook contains a digest-verification command binding the pinned digest');
const r = spawnSync(digestCmd, { cwd: REPO, shell: true, encoding: 'utf8' });
assert.equal(r.status, 0, `the runbook digest command exits 0 (status=${r.status}, stderr=${r.stderr?.slice(0, 300)})`);
assert.ok(r.stdout.includes(`digest OK ${EXPECTED_DIGEST}`), `the runbook digest command prints "digest OK ${EXPECTED_DIGEST}" (stdout=${r.stdout?.slice(0, 300)})`);
ok('the mandatory runbook digest-verification command executes exactly as committed (exit 0, prints digest OK)');

// 3) the runbook binds the real 0105 artifacts (not 0104's): digest, token, runner + readback + npm scripts.
for (const needle of [
  EXPECTED_DIGEST,
  'apply-ps-497-claim-not-applicable-status-0105',
  'scripts/apply-ps-497-claim-not-applicable-status.ts',
  'scripts/ps-497-0105-readback.ts',
  'migrate:ps-497-claim-not-applicable-status',
]) {
  assert.ok(runbook.includes(needle), `runbook references ${needle}`);
}
// It must NOT bind 0104's identity (that authorization does not authorize 0105).
assert.ok(!runbook.includes('bf8038d264'), 'runbook must not bind the 0104 digest');
ok('runbook binds the 0105 artifacts (digest/token/runner/readback/script) and not 0104 identity');

console.log(`\nPASS PS-497 0105 runbook smoke — ${passed}/${passed} checks`);
