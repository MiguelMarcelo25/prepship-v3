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

console.log('\nthe stack stays provisionable');

check('the socket server raises maxConnections above its default of 1', () => {
  // The default is 1 and the API opens several independent postgres() clients, so at the
  // default the refused connections tear down the ACTIVE socket: /health/ready answers
  // 503, the web app renders the maintenance page instead of the shell, and bulk-import
  // PATCHes fail intermittently with a driver-level "Failed query".
  const code = stackSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const match = /maxConnections:\s*(\d+)/.exec(code);
  assert.ok(match, 'the socket server does not set maxConnections');
  assert.ok(Number(match[1]) > 1, `maxConnections is ${match[1]}; the default of 1 cannot serve this API`);
});

check('background cadence is disabled on the QA stack', () => {
  // Either reason alone is sufficient: a watchdog tick can mutate the very fixtures a
  // spec asserts on, and each background service builds its own postgres() client, so the
  // ticks add connection churn against a database with a hard connection ceiling. Leaving
  // these on cost the suite 3.9 minutes and intermittent failures.
  const code = stackSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const flag of [
    'SHIPMENT_SYNC_WATCHDOG_ENABLED',
    'RUN_ORDERS_PERFORMANCE_MAINTENANCE',
    'RUN_SYNC_SCHEDULER',
  ]) {
    assert.match(
      code,
      new RegExp(`${flag}:\\s*'false'`),
      `${flag} must be set to 'false' in the QA environment`,
    );
  }
});

check('the query endpoint reads over the socket, not the in-process PGlite handle', () => {
  // An in-process pg.query() interleaves with whatever the socket server is serving, and
  // PGlite is single-threaded: a spec's own read-back could knock over an unrelated
  // request the browser had just issued. The resulting failure lands on the request in
  // flight rather than on the cause, which makes it near-impossible to attribute.
  const code = stackSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/\bpg\.query\s*\(/.test(code),
    'the stack calls pg.query() in-process — route reads through the socket client instead',
  );
});

check('gotoApp waits for readiness and never clicks past the maintenance page', () => {
  // ServiceAvailabilityGate renders MaintenanceModePage on a 503 readiness, so a UI spec
  // on a mis-provisioned stack otherwise fails at whatever it clicked first. Clicking
  // "Continue to app" would let a broken stack look healthy, which is the one outcome
  // this harness exists to prevent.
  const code = harnessSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /health\/ready/, 'gotoApp must wait on /health/ready before navigating');
  assert.ok(
    !/click\(\)[\s\S]{0,80}Continue to app|Continue to app[\s\S]{0,80}\.click\(\)/.test(code),
    'the harness clicks past the maintenance gate — a broken stack would look healthy',
  );
});

console.log('\nthe stack runs on a CLEAN checkout, not just a dev box');

check('seeders receive the same SUPABASE_* contract the API child does', () => {
  // The Step 12 fixture imports src/db/client -> src/lib/env.ts, which hard-requires the
  // four SUPABASE_* values off-serverless and exits 1 without them. Passing them to the
  // API spawn only worked because a dev machine has an untracked repo-root .env; on CI or
  // a fresh clone the seeder died before a single spec ran. Asserted as ONE shared object
  // rather than two literal lists, because the root cause was two spawns satisfying the
  // same contract independently and drifting.
  const code = stackSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /const qaSupabaseEnv\s*=\s*\{/, 'the shared SUPABASE env object is gone');
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET']) {
    assert.ok(
      new RegExp(`qaSupabaseEnv[\\s\\S]{0,400}${key}`).test(code),
      `${key} is not in the shared qaSupabaseEnv object`,
    );
  }
  assert.match(code, /runSeeder\([^)]*env:\s*qaSupabaseEnv/, 'runSeeder no longer receives the shared env');
  assert.match(code, /\.\.\.qaSupabaseEnv/, 'the API env no longer spreads the shared object');
});

check('every tolerated migration pins the REASON, not just the filename', () => {
  // Name-only tolerance absorbs a migration that starts failing for a NEW cause, which is
  // the exact case the allowlist exists to catch. Each entry carries an `expect` pattern
  // matched against the real error, and those patterns were captured from actual output
  // rather than guessed -- the first guess here was wrong and this check caught it.
  const entries = stackSrc.match(/\[\s*'0\d{3}[^']*\.sql'\s*,\s*\{[\s\S]*?\}\s*\]/g) ?? [];
  assert.ok(entries.length >= 7, `expected the tolerated-migration allowlist, found ${entries.length} entries`);
  for (const entry of entries) {
    const file = /'([^']+\.sql)'/.exec(entry)?.[1];
    assert.match(entry, /reason:\s*'/, `${file} has no stated reason`);
    assert.match(entry, /expect:\s*\//, `${file} tolerates by NAME only — pin the expected error`);
  }
});

check('the PS-507 suite is registered in BOTH CI and the deploy gate', () => {
  // render-auto-deploy.yml does NOT wait on ci.yml; it re-runs its own list. The two
  // diverging is how a red PS-464 once reached production, which is why the SOT pack was
  // copied into the deploy gate. This suite must not recreate that gap.
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const deploy = readFileSync('.github/workflows/render-auto-deploy.yml', 'utf8');
  for (const [label, src] of [['ci.yml', ci], ['render-auto-deploy.yml', deploy]] as const) {
    assert.ok(src.includes('npm run test:ps-507'), `${label} does not run the PS-507 suite`);
    assert.ok(
      /playwright install[^\n]*chromium/.test(src),
      `${label} runs the PS-507 suite without installing Chromium — the browser leg cannot run`,
    );
  }
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
