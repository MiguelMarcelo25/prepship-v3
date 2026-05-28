import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

const helperSource = fs.existsSync(path.join(root, 'scripts/lib/detailed-guard-report.mjs'))
  ? read('scripts/lib/detailed-guard-report.mjs')
  : '';
const queueLabelGuard = read('scripts/test-order-queue-label-guard.mjs');
const invalidLabelGuard = read('scripts/print-queue-invalid-label-guard.mjs');
const pkg = JSON.parse(read('package.json'));

assert(
  helperSource.includes('createGuardReport') &&
    helperSource.includes('why') &&
    helperSource.includes('failure') &&
    helperSource.includes('fix') &&
    helperSource.includes('evidence'),
  'detailed guard helper must print why a check exists, what failed, evidence, and fix guidance',
);

for (const [name, source] of [
  ['test-order-queue-label-guard', queueLabelGuard],
  ['print-queue-invalid-label-guard', invalidLabelGuard],
]) {
  assert(
    source.includes("from './lib/detailed-guard-report.mjs'") &&
      source.includes('createGuardReport') &&
      source.includes('report.check') &&
      source.includes('report.finish'),
    `${name} must use detailed guard reporting instead of bare PASS/FAIL output`,
  );
  assert(
    source.includes('why:') &&
      source.includes('failure:') &&
      source.includes('fix:') &&
      source.includes('evidence:'),
    `${name} checks must include operator-facing diagnosis metadata`,
  );
}

assert(
  pkg.scripts?.['test:queue-label-diagnostics'] ===
    'npm run test:test-order-queue-label && npm run test:print-queue-invalid-label && node scripts/detailed-guard-output-guard.mjs',
  'package.json must expose one detailed queue-label diagnostics command',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
