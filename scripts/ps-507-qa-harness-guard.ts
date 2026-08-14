#!/usr/bin/env tsx
/**
 * PS-507 — pins the safety properties of the disposable QA harness.
 *
 * Hermetic: pure imports and file reads. No stack, no database, no network.
 *
 * WHY A GUARD AT ALL. The harness's value is entirely in what it REFUSES. If the
 * loopback check softens, or a spec starts mocking the persistence path it claims to
 * prove, the suite keeps passing and PS-499 and PS-488 keep citing it — while it is no
 * longer evidence of anything. That failure is silent by construction, which is exactly
 * the shape the SOT pack exists to catch.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  assertDisposableTarget,
  assertTestEnvironment,
  mintQaToken,
  redact,
} from './ps-507-qa-stack.mjs';

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

const stackSrc = readFileSync('scripts/ps-507-qa-stack.mjs', 'utf8');
const harnessSrc = readFileSync('web/e2e/support/ps-507-harness.js', 'utf8');
const configSrc = readFileSync('playwright.ps507.config.js', 'utf8');

console.log('PS-507 QA harness guard\n');
console.log('production targets are refused');

// The real hosts from this repo's own production stack. If any of these were ever
// accepted, the harness could provision against, or authenticate to, production.
const PRODUCTION_TARGETS: Array<[string, string]> = [
  ['supabase pooler', 'postgres://u:p@aws-1-us-west-1.pooler.supabase.com:6543/postgres'],
  ['supabase direct', 'postgres://u:p@db.fdkseckgfuvdczzqmnac.supabase.co:5432/postgres'],
  ['render api', 'https://prepshipv4-api-l5xc.onrender.com'],
  ['vercel frontend', 'https://prepshipv4.vercel.app'],
  ['arbitrary remote', 'postgres://u:p@10.0.0.5:5432/prod'],
  ['public hostname', 'http://db.internal.example.com:5432'],
];

for (const [label, url] of PRODUCTION_TARGETS) {
  check(`refuses ${label}`, () => {
    assert.throws(() => assertDisposableTarget(url), /STOP/, `${url} was ACCEPTED`);
  });
}

check('accepts loopback in the forms the stack actually builds', () => {
  assertDisposableTarget('postgres://postgres:postgres@127.0.0.1:55507/prepship_ps507_qa');
  assertDisposableTarget('http://127.0.0.1:45507');
  assertDisposableTarget('http://127.0.0.1:25507/query');
});

check('refuses to provision outside NODE_ENV=test', () => {
  assert.throws(() => assertTestEnvironment('production'), /STOP/);
  assert.throws(() => assertTestEnvironment(undefined), /STOP/);
  assertTestEnvironment('test');
});

console.log('\nsecrets never printed');

check('redact never returns the input for a secret-length value', () => {
  const secret = 'a'.repeat(96);
  const shown = redact(secret);
  assert.notEqual(shown, secret);
  assert.ok(!shown.includes(secret));
  assert.match(shown, /\d+ chars/);
});

check('the stack prints the jwt secret only through redact()', () => {
  // A bare `${jwtSecret}` in a log line would put a live signing key in CI output.
  const bareInterpolation = /\$\{jwtSecret\}(?![^`]*redact)/.test(
    stackSrc.replace(/redact\(jwtSecret\)/g, 'REDACTED_CALL'),
  );
  assert.equal(bareInterpolation, false, 'jwtSecret is interpolated without redact()');
});

console.log('\nthe persistence path is never mocked');

check('PS-507 specs do not use page.route', () => {
  // The rest of web/e2e mocks every response, which is legitimate there. A PS-507 spec
  // doing it would be claiming persistence it never touched.
  const specs = readdirSync('web/e2e').filter((f) => /^ps-507-.*\.spec\.js$/.test(f));
  assert.ok(specs.length >= 2, 'expected the PS-507 specs to exist');
  for (const spec of specs) {
    const src = readFileSync(`web/e2e/${spec}`, 'utf8');
    assert.ok(
      !/page\.route\s*\(/.test(src),
      `${spec} calls page.route — the persistence path under test must not be mocked`,
    );
  }
});

check('the harness asserts against the database, not the DOM', () => {
  assert.match(harnessSrc, /export async function qaQuery/);
  assert.match(harnessSrc, /export async function expectExactlyOneRow/);
  assert.match(harnessSrc, /export async function expectNoRows/);
});

check('expectNoRows fails loudly rather than returning a boolean', () => {
  // A helper that returns false instead of throwing turns "no sidecar was written" into
  // a value a caller can forget to check.
  assert.match(harnessSrc, /expected NO \$\{label\}[\s\S]{0,200}A forbidden write occurred/);
});

console.log('\nthe QA config cannot borrow the mocked suite');

check('the PS-507 playwright config starts no server of its own', () => {
  assert.ok(!/webServer\s*:/.test(configSrc), 'the stack owns every server; a webServer block would fight it');
  assert.ok(!/globalSetup\s*:/.test(configSrc), 'globalSetup asserts port 5177, which is the mocked suite');
});

check('the PS-507 config never targets port 5177', () => {
  // 5177 is contended by other agents' env-less vite servers; pointing there would run
  // the persistence suite against whatever happened to be listening.
  //
  // Matches a USED port, not the word. Both files mention 5177 in comments explaining
  // why they avoid it, and a bare substring test would make those explanations
  // unsatisfiable — the same prose-matching trap that bit the PS-505 guard.
  const usesPort = (src: string) => /(?:127\.0\.0\.1|localhost):5177|port['"\s:=]+5177/.test(
    src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''),
  );
  assert.equal(usesPort(configSrc), false, 'the PS-507 config points at 5177');
  assert.equal(usesPort(stackSrc), false, 'the stack binds or targets 5177');
});

console.log('\nauth is real and least-privilege');

check('a token minted with the wrong secret differs from the right one', () => {
  const args = { sub: 'u', email: 'u@example.test' } as const;
  const right = mintQaToken({ secret: 'a'.repeat(48), ...args });
  const wrong = mintQaToken({ secret: 'b'.repeat(48), ...args });
  assert.notEqual(right.split('.')[2], wrong.split('.')[2], 'signatures must differ');
});

check('permissions default to EMPTY, never to an admin set', () => {
  const token = mintQaToken({ secret: 'a'.repeat(48), sub: 'u', email: 'u@example.test' });
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  assert.deepEqual(
    payload.app_metadata.permissions, [],
    'a blanket token would mask authorisation regressions in every consumer',
  );
});

console.log('\nseeding cannot deadlock the socket');

check('seeders are spawned asynchronously, never spawnSync', () => {
  // spawnSync blocks the event loop the PGLite socket server runs in, so the seeder
  // cannot connect and dies with CONNECT_TIMEOUT against a healthy socket.
  //
  // Matches a CALL, and only after stripping comments — runSeeder's own comment names
  // spawnSync to explain why it is not used, and a bare substring test would forbid the
  // explanation rather than the mistake.
  const code = stackSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/spawnSync\s*\(/.test(code), 'the stack calls spawnSync — it must use async spawn');
});

console.log('\nself-wiring');

check('package.json exposes the PS-507 commands', () => {
  const pkg = readFileSync('package.json', 'utf8');
  for (const script of ['test:ps-507', 'test:ps-507-step12', 'test:ps-507-persistence']) {
    assert.ok(pkg.includes(`"${script}"`), `missing npm script ${script}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('\nFAILURES');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PS-507 QA harness guard passed.');
